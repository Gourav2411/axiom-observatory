import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
} from "./rag-pipeline.js";

const EMBEDDING_TIMEOUT_MS = 25_000;
const MAX_BATCH_SIZE = 6;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

class EmbeddingError extends Error {
  constructor(message, { status = null, code = "embedding_unavailable", cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "EmbeddingError";
    this.status = status;
    this.code = code;
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_SIZE) {
    throw new EmbeddingError(`Embedding batches must contain between 1 and ${MAX_BATCH_SIZE} items`, {
      code: "invalid_embedding_batch",
    });
  }
  const ids = new Set();
  return items.map((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const input = typeof item?.input === "string" ? item.input.trim() : "";
    const inputLength = [...input].length;
    if (!id || [...id].length > 256 || ids.has(id) || inputLength < 3 || inputLength > 2_000) {
      throw new EmbeddingError("Embedding items require unique IDs up to 256 characters and inputs between 3 and 2000 characters", {
        code: "invalid_embedding_batch",
      });
    }
    ids.add(id);
    return { id, input };
  });
}

function validateEmbeddingResponse(payload, expectedIds) {
  if (!payload || typeof payload !== "object"
    || payload.model !== EMBEDDING_MODEL
    || payload.revision !== EMBEDDING_REVISION
    || payload.dimensions !== EMBEDDING_DIMENSIONS
    || payload.normalized !== true
    || !Array.isArray(payload.embeddings)
    || payload.embeddings.length !== expectedIds.size) {
    throw new EmbeddingError("The embedding worker returned an incompatible model contract", {
      code: "invalid_embedding_response",
    });
  }

  const vectors = new Map();
  for (const item of payload.embeddings) {
    if (!expectedIds.has(item?.id) || vectors.has(item.id)
      || !Array.isArray(item.embedding)
      || item.embedding.length !== EMBEDDING_DIMENSIONS
      || !item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new EmbeddingError("The embedding worker returned an invalid vector", {
        code: "invalid_embedding_response",
      });
    }
    const magnitudeSquared = item.embedding.reduce((total, value) => total + value * value, 0);
    if (!Number.isFinite(magnitudeSquared) || Math.abs(magnitudeSquared - 1) > 0.02) {
      throw new EmbeddingError("The embedding worker returned a non-normalized vector", {
        code: "invalid_embedding_response",
      });
    }
    vectors.set(item.id, item.embedding);
  }
  if (vectors.size !== expectedIds.size) {
    throw new EmbeddingError("The embedding worker omitted a requested vector", {
      code: "invalid_embedding_response",
    });
  }
  return [...expectedIds].map((id) => ({ id, embedding: vectors.get(id) }));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfterHeader = response?.headers?.get("retry-after");
  const retryAfter = retryAfterHeader == null || retryAfterHeader === "" ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 2_000);
  return 200 * (2 ** (attempt - 1));
}

function createEmbeddingClient({
  supabaseUrl,
  serviceRoleKey,
  accessToken,
  transport = globalThis.fetch,
  sleep = defaultSleep,
}) {
  let endpoint;
  try {
    endpoint = new URL("/functions/v1/axiom-embed", `${supabaseUrl.replace(/\/+$/, "")}/`);
  } catch (error) {
    throw new EmbeddingError("The embedding worker URL is invalid", { cause: error });
  }
  if (typeof transport !== "function" || !serviceRoleKey || !accessToken) {
    throw new EmbeddingError("The embedding worker is not configured");
  }

  return {
    async embed(items) {
      const validated = validateItems(items);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
        let response;
        try {
          response = await transport(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              apikey: serviceRoleKey,
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
              "x-axiom-internal-key": serviceRoleKey,
            },
            body: JSON.stringify({ items: validated }),
            signal: controller.signal,
          });
        } catch (error) {
          const failure = new EmbeddingError(
            error?.name === "AbortError" ? "The embedding worker timed out" : "The embedding worker is unavailable",
            { cause: error },
          );
          if (attempt === MAX_ATTEMPTS) throw failure;
          await sleep(retryDelay(null, attempt));
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const failure = new EmbeddingError("The embedding worker rejected the request", {
            status: response.status,
            code: payload?.error?.code ?? "embedding_unavailable",
          });
          if (attempt === MAX_ATTEMPTS || !RETRYABLE_STATUSES.has(response.status)) throw failure;
          await sleep(retryDelay(response, attempt));
          continue;
        }
        const payload = await response.json().catch(() => null);
        const embeddings = validateEmbeddingResponse(payload, new Set(validated.map((item) => item.id)));
        return {
          model: payload.model,
          revision: payload.revision,
          dimensions: payload.dimensions,
          normalized: payload.normalized,
          embeddings,
        };
      }
      throw new EmbeddingError("The embedding worker exhausted its retry budget");
    },
  };
}

export {
  EMBEDDING_TIMEOUT_MS,
  MAX_ATTEMPTS,
  EmbeddingError,
  createEmbeddingClient,
  validateEmbeddingResponse,
};

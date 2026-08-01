import { EmbeddingError, createEmbeddingClient } from "./embedding-client.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
} from "./rag-pipeline.js";

const RUN_SNAPSHOTS_TABLE = "run_snapshots";
const SUPABASE_TIMEOUT_MS = 8_000;
const MAX_RUN_CHUNKS = 500;
const EMBEDDING_BATCH_SIZE = 6;

class PersistenceError extends Error {
  constructor(message, { operation, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PersistenceError";
    this.operation = operation;
    this.status = status;
  }
}

const memorySnapshots = new Map();

function persistenceState(mode, durable, configured, available) {
  return { mode, durable, configured, available };
}

function memoryRepository() {
  const persistence = persistenceState("ephemeral_memory", false, false, true);
  return {
    persistence,
    async prepare() {
      return null;
    },
    async health() {
      return persistence;
    },
    async put(run) {
      memorySnapshots.set(run.id, structuredClone(run));
      return run;
    },
    async ingest(run) {
      memorySnapshots.set(run.id, structuredClone(run));
      return { mode: "ephemeral_memory", normalized: false };
    },
    async get(id) {
      const run = memorySnapshots.get(id);
      return run ? structuredClone(run) : null;
    },
  };
}

function unavailableRepository(reason, configured = false) {
  const persistence = persistenceState("supabase_postgres", false, configured, false);
  const fail = async (operation) => {
    throw new PersistenceError(reason, { operation });
  };
  return {
    persistence,
    prepare: () => fail("configure"),
    async health() {
      return persistence;
    },
    put: () => fail("write"),
    ingest: () => fail("ingest"),
    index: () => fail("index"),
    retrieve: () => fail("retrieval"),
    get: () => fail("read"),
  };
}

function supabaseHeaders(serviceRoleKey, write = false, accessToken = serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "accept-profile": "public",
    ...(write ? {
      "content-profile": "public",
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    } : {}),
  };
}

async function fetchWithPersistenceTimeout(transport, input, init, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    return await transport(input, { ...init, signal: controller.signal });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    throw new PersistenceError(
      timeout ? "Durable run storage timed out" : "Durable run storage is unavailable",
      { operation, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function runToSnapshotRow(run, { workspaceId = null, userId = null } = {}) {
  return {
    id: run.id,
    workspace_id: workspaceId,
    created_by: userId,
    schema_version: run.schemaVersion ?? null,
    status: run.status ?? null,
    target_id: run.target?.id ?? null,
    disease_id: run.disease?.id ?? null,
    created_at: run.createdAt ?? new Date().toISOString(),
    updated_at: run.updatedAt ?? new Date().toISOString(),
    snapshot: run,
  };
}

function supabaseRepository({
  supabaseUrl,
  serviceRoleKey,
  transport,
  embeddingTransport,
  principal = null,
}) {
  let endpoint;
  let workspaceEndpoint;
  let ingestEndpoint;
  let chunksEndpoint;
  let applyEmbeddingsEndpoint;
  let retrievalEndpoint;
  try {
    endpoint = new URL(`/rest/v1/${RUN_SNAPSHOTS_TABLE}`, `${supabaseUrl.replace(/\/+$/, "")}/`);
    workspaceEndpoint = new URL("/rest/v1/rpc/ensure_default_workspace", `${supabaseUrl.replace(/\/+$/, "")}/`);
    ingestEndpoint = new URL("/rest/v1/rpc/persist_evidence_run_v1", `${supabaseUrl.replace(/\/+$/, "")}/`);
    chunksEndpoint = new URL("/rest/v1/document_chunks", `${supabaseUrl.replace(/\/+$/, "")}/`);
    applyEmbeddingsEndpoint = new URL("/rest/v1/rpc/apply_chunk_embeddings_v1", `${supabaseUrl.replace(/\/+$/, "")}/`);
    retrievalEndpoint = new URL("/rest/v1/rpc/execute_run_retrieval_v2", `${supabaseUrl.replace(/\/+$/, "")}/`);
  } catch (error) {
    return unavailableRepository("Supabase persistence URL is invalid", true);
  }

  const persistence = persistenceState("supabase_postgres", true, true, true);
  let resolvedWorkspaceId = null;

  async function ensureWorkspace() {
    if (resolvedWorkspaceId) return resolvedWorkspaceId;
    if (!principal?.accessToken || !principal?.userId) {
      throw new PersistenceError("An authenticated Supabase context is required", { operation: "authorize" });
    }
    const response = await fetchWithPersistenceTimeout(transport, workspaceEndpoint, {
      method: "POST",
      headers: supabaseHeaders(serviceRoleKey, true, principal.accessToken),
      body: "{}",
    }, "workspace");
    if (!response.ok) {
      throw new PersistenceError("The user workspace could not be resolved", {
        operation: "workspace",
        status: response.status,
      });
    }
    try {
      resolvedWorkspaceId = await response.json();
    } catch (error) {
      throw new PersistenceError("The workspace resolver returned an invalid response", {
        operation: "workspace",
        status: response.status,
        cause: error,
      });
    }
    if (typeof resolvedWorkspaceId !== "string" || !/^[0-9a-f-]{36}$/i.test(resolvedWorkspaceId)) {
      throw new PersistenceError("The workspace resolver returned an invalid identifier", {
        operation: "workspace",
        status: response.status,
      });
    }
    return resolvedWorkspaceId;
  }

  function requirePrincipal(operation) {
    if (!principal?.accessToken || !principal?.userId) {
      throw new PersistenceError("An authenticated Supabase context is required", { operation });
    }
  }

  async function parseJsonResponse(response, operation, message) {
    if (!response.ok) {
      throw new PersistenceError(message, { operation, status: response.status });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new PersistenceError(`${message}: invalid JSON response`, {
        operation,
        status: response.status,
        cause: error,
      });
    }
  }

  async function applyEmbeddings(runId, embeddingResponse, complete) {
    const response = await fetchWithPersistenceTimeout(transport, applyEmbeddingsEndpoint, {
      method: "POST",
      headers: {
        ...supabaseHeaders(serviceRoleKey, true, serviceRoleKey),
        prefer: "return=representation",
      },
      body: JSON.stringify({
        p_run_id: runId,
        p_model: embeddingResponse?.model ?? EMBEDDING_MODEL,
        p_revision: embeddingResponse?.revision ?? EMBEDDING_REVISION,
        p_items: embeddingResponse?.embeddings ?? [],
        p_complete: complete,
      }),
    }, "index");
    return parseJsonResponse(response, "index", "The normalized embedding index rejected an update");
  }

  return {
    persistence,
    async prepare() {
      return {
        workspaceId: await ensureWorkspace(),
        createdBy: principal.userId,
      };
    },
    async health() {
      const url = new URL(endpoint);
      url.searchParams.set("select", "id");
      url.searchParams.set("limit", "1");
      try {
        const response = await fetchWithPersistenceTimeout(transport, url, {
          method: "GET",
          headers: supabaseHeaders(serviceRoleKey),
        }, "health");
        return { ...persistence, durable: response.ok, available: response.ok };
      } catch {
        return { ...persistence, durable: false, available: false };
      }
    },
    async put(run) {
      const workspaceId = await ensureWorkspace();
      const ownedRun = {
        ...run,
        workspaceId,
        createdBy: principal.userId,
      };
      const url = new URL(endpoint);
      url.searchParams.set("on_conflict", "id");
      const response = await fetchWithPersistenceTimeout(transport, url, {
        method: "POST",
        headers: supabaseHeaders(serviceRoleKey, true, principal.accessToken),
        body: JSON.stringify(runToSnapshotRow(ownedRun, { workspaceId, userId: principal.userId })),
      }, "write");
      if (!response.ok) {
        throw new PersistenceError("Durable run storage rejected the write", {
          operation: "write",
          status: response.status,
        });
      }
      return ownedRun;
    },
    async ingest(run, payload) {
      const workspaceId = await ensureWorkspace();
      const ownedRun = {
        ...run,
        workspaceId,
        createdBy: principal.userId,
      };
      const response = await fetchWithPersistenceTimeout(transport, ingestEndpoint, {
        method: "POST",
        headers: {
          ...supabaseHeaders(serviceRoleKey, true, principal.accessToken),
          prefer: "return=representation",
        },
        body: JSON.stringify({
          p_payload: {
            ...payload,
            snapshot: ownedRun,
          },
        }),
      }, "ingest");
      return parseJsonResponse(response, "ingest", "The normalized evidence transaction was rejected");
    },
    async index(runId) {
      requirePrincipal("index");
      const url = new URL(chunksEndpoint);
      url.searchParams.set("run_id", `eq.${runId}`);
      url.searchParams.set("embedding", "is.null");
      url.searchParams.set("select", "id,content,content_sha256,chunk_index");
      url.searchParams.set("order", "chunk_index.asc,id.asc");
      url.searchParams.set("limit", String(MAX_RUN_CHUNKS + 1));
      const response = await fetchWithPersistenceTimeout(transport, url, {
        method: "GET",
        headers: supabaseHeaders(serviceRoleKey, false, principal.accessToken),
      }, "index");
      const chunks = await parseJsonResponse(response, "index", "The normalized chunks could not be read");
      if (!Array.isArray(chunks)) {
        throw new PersistenceError("The normalized chunk index returned an invalid response", { operation: "index" });
      }
      if (chunks.length > MAX_RUN_CHUNKS) {
        throw new PersistenceError("The run exceeds the bounded indexing batch size", { operation: "index" });
      }

      if (!chunks.length) {
        const summary = await applyEmbeddings(runId, {
          model: EMBEDDING_MODEL,
          revision: EMBEDDING_REVISION,
          embeddings: [],
        }, true);
        return {
          model: EMBEDDING_MODEL,
          revision: EMBEDDING_REVISION,
          dimensions: EMBEDDING_DIMENSIONS,
          normalized: true,
          indexedNow: 0,
          ...summary,
        };
      }

      const client = createEmbeddingClient({
        supabaseUrl,
        serviceRoleKey,
        accessToken: principal.accessToken,
        transport: embeddingTransport,
      });
      let finalSummary = null;
      for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const embedded = await client.embed(batch.map((chunk) => ({ id: chunk.id, input: chunk.content })));
        finalSummary = await applyEmbeddings(
          runId,
          embedded,
          offset + EMBEDDING_BATCH_SIZE >= chunks.length,
        );
      }
      return {
        model: EMBEDDING_MODEL,
        revision: EMBEDDING_REVISION,
        dimensions: EMBEDDING_DIMENSIONS,
        normalized: true,
        indexedNow: chunks.length,
        ...(finalSummary ?? {}),
      };
    },
    async retrieve(runId, query, topK) {
      requirePrincipal("retrieval");
      let queryEmbedding = null;
      let embeddingFallback = null;
      try {
        const client = createEmbeddingClient({
          supabaseUrl,
          serviceRoleKey,
          accessToken: principal.accessToken,
          transport: embeddingTransport,
        });
        const embedded = await client.embed([{ id: "query", input: query }]);
        queryEmbedding = embedded.embeddings[0].embedding;
      } catch (error) {
        if (!(error instanceof EmbeddingError)) throw error;
        embeddingFallback = "The open-source embedding worker was unavailable; Postgres full-text retrieval was used.";
      }

      const response = await fetchWithPersistenceTimeout(transport, retrievalEndpoint, {
        method: "POST",
        headers: {
          ...supabaseHeaders(serviceRoleKey, true, principal.accessToken),
          prefer: "return=representation",
        },
        body: JSON.stringify({
          p_run_id: runId,
          p_query_text: query,
          p_query_embedding: queryEmbedding,
          p_embedding_model: queryEmbedding ? EMBEDDING_MODEL : null,
          p_embedding_revision: queryEmbedding ? EMBEDDING_REVISION : null,
          p_top_k: topK,
          p_rrf_k: 60,
        }),
      }, "retrieval");
      const result = await parseJsonResponse(response, "retrieval", "The hybrid retrieval transaction was rejected");
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new PersistenceError("The hybrid retrieval transaction returned an invalid response", { operation: "retrieval" });
      }
      if (embeddingFallback) {
        result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), embeddingFallback];
      }
      return result;
    },
    async get(id) {
      if (!principal?.accessToken) {
        throw new PersistenceError("An authenticated Supabase context is required", { operation: "authorize" });
      }
      const url = new URL(endpoint);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set("select", "snapshot");
      url.searchParams.set("limit", "1");
      const response = await fetchWithPersistenceTimeout(transport, url, {
        method: "GET",
        headers: supabaseHeaders(serviceRoleKey, false, principal.accessToken),
      }, "read");
      if (!response.ok) {
        throw new PersistenceError("Durable run storage rejected the read", {
          operation: "read",
          status: response.status,
        });
      }
      let rows;
      try {
        rows = await response.json();
      } catch (error) {
        throw new PersistenceError("Durable run storage returned an invalid response", {
          operation: "read",
          status: response.status,
          cause: error,
        });
      }
      if (!Array.isArray(rows) || !rows.length) return null;
      const snapshot = rows[0]?.snapshot;
      return snapshot && typeof snapshot === "object" ? snapshot : null;
    },
  };
}

function createRunRepository(env = {}, principal = null) {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const serviceRoleKey = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string"
    ? env.SUPABASE_SERVICE_ROLE_KEY.trim()
    : "";

  if (!supabaseUrl && !serviceRoleKey) return memoryRepository();
  if (!supabaseUrl || !serviceRoleKey) {
    return unavailableRepository("Supabase persistence configuration is incomplete");
  }

  const transport = env.SUPABASE_FETCH ?? env.PERSISTENCE_FETCH ?? globalThis.fetch;
  const embeddingTransport = env.EMBEDDING_FETCH ?? globalThis.fetch;
  if (typeof transport !== "function") {
    return unavailableRepository("Supabase persistence transport is unavailable");
  }
  return supabaseRepository({
    supabaseUrl,
    serviceRoleKey,
    transport,
    embeddingTransport,
    principal,
  });
}

export {
  PersistenceError,
  RUN_SNAPSHOTS_TABLE,
  createRunRepository,
  runToSnapshotRow,
};

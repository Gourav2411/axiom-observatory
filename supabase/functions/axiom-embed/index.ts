import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "Supabase/gte-small";
const MODEL_REVISION = "supabase-edge-runtime-managed";
const DIMENSIONS = 384;
const MAX_BATCH_SIZE = 6;
const MIN_INPUT_CHARACTERS = 3;
const MAX_INPUT_CHARACTERS = 2_000;
const MAX_ID_CHARACTERS = 256;

// Supabase Edge Runtime currently exposes gte-small as a built-in model. Keeping
// the session at module scope lets warm function instances reuse the loaded model.
const embeddingModel = new Supabase.ai.Session("gte-small");

type ValidatedItem = {
  id: string;
  input: string;
};

type ErrorCode =
  | "method_not_allowed"
  | "unauthorized"
  | "invalid_json"
  | "invalid_request"
  | "embedding_failed";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function validatePayload(
  payload: unknown,
): { items: ValidatedItem[] } | { error: string } {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return { error: "Body must contain an items array." };
  }

  if (payload.items.length < 1 || payload.items.length > MAX_BATCH_SIZE) {
    return {
      error: `items must contain between 1 and ${MAX_BATCH_SIZE} entries.`,
    };
  }

  const items: ValidatedItem[] = [];
  const ids = new Set<string>();

  for (const [index, item] of payload.items.entries()) {
    if (!isRecord(item)) {
      return { error: `items[${index}] must be an object.` };
    }

    if (typeof item.id !== "string") {
      return { error: `items[${index}].id must be a string.` };
    }

    const id = item.id.trim();
    if (characterCount(id) < 1 || characterCount(id) > MAX_ID_CHARACTERS) {
      return {
        error: `items[${index}].id must be between 1 and ${MAX_ID_CHARACTERS} characters.`,
      };
    }
    if (ids.has(id)) {
      return { error: `items[${index}].id must be unique within the batch.` };
    }

    if (typeof item.input !== "string") {
      return { error: `items[${index}].input must be a string.` };
    }

    const input = item.input.trim();
    const inputLength = characterCount(input);
    if (
      inputLength < MIN_INPUT_CHARACTERS ||
      inputLength > MAX_INPUT_CHARACTERS
    ) {
      return {
        error:
          `items[${index}].input must be between ${MIN_INPUT_CHARACTERS} and ${MAX_INPUT_CHARACTERS} characters after trimming.`,
      };
    }

    ids.add(id);
    items.push({ id, input });
  }

  return { items };
}

function asFiniteEmbedding(value: unknown): number[] | null {
  const embedding = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<number>)
      : null;
  if (embedding === null || embedding.length !== DIMENSIONS) return null;
  if (!embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  const magnitudeSquared = embedding.reduce(
    (total, entry) => total + entry * entry,
    0,
  );
  if (!Number.isFinite(magnitudeSquared) || Math.abs(magnitudeSquared - 1) > 0.02) {
    return null;
  }
  return embedding as number[];
}

async function internalKeyMatches(provided: string, expected: string): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      "method_not_allowed",
      "Only POST requests are supported.",
      { allow: "POST" },
    );
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return errorResponse(
      401,
      "unauthorized",
      "A valid bearer token is required.",
      { "www-authenticate": "Bearer" },
    );
  }

  const expectedInternalKey = Deno.env.get("AXIOM_EMBED_INTERNAL_KEY")
    ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    ?? "";
  const providedInternalKey = request.headers.get("x-axiom-internal-key") ?? "";
  if (!await internalKeyMatches(providedInternalKey, expectedInternalKey)) {
    return errorResponse(
      403,
      "unauthorized",
      "This embedding endpoint is restricted to the Axiom server.",
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body must be valid JSON.");
  }

  const validation = validatePayload(payload);
  if ("error" in validation) {
    return errorResponse(400, "invalid_request", validation.error);
  }

  try {
    const embeddings: Array<{ id: string; embedding: number[] }> = [];

    // Run the small bounded batch sequentially so a single model session is not
    // invoked concurrently and the endpoint remains all-or-nothing.
    for (const item of validation.items) {
      const output = await embeddingModel.run(item.input, {
        mean_pool: true,
        normalize: true,
      });
      const embedding = asFiniteEmbedding(output);

      if (embedding === null) {
        throw new Error("The embedding runtime returned an invalid vector.");
      }

      embeddings.push({ id: item.id, embedding });
    }

    return new Response(JSON.stringify({
      model: MODEL,
      revision: MODEL_REVISION,
      dimensions: DIMENSIONS,
      normalized: true,
      embeddings,
    }), { status: 200, headers: jsonHeaders });
  } catch (error) {
    // Do not expose model/runtime details or request content to callers.
    console.error(
      "axiom-embed inference failed",
      error instanceof Error ? error.name : "unknown_error",
    );
    return errorResponse(
      500,
      "embedding_failed",
      "Unable to generate embeddings at this time.",
    );
  }
});

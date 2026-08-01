import assert from "node:assert/strict";
import test from "node:test";
import {
  EmbeddingError,
  createEmbeddingClient,
  validateEmbeddingResponse,
} from "../worker/embedding-client.js";

const unitValue = 1 / Math.sqrt(384);
const unitEmbedding = Array.from({ length: 384 }, () => unitValue);

test("embedding client keeps user identity and the internal key server-side", async () => {
  const calls = [];
  const client = createEmbeddingClient({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    accessToken: "user-access-token",
    transport: async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({
        model: "Supabase/gte-small",
        revision: "supabase-edge-runtime-managed",
        dimensions: 384,
        normalized: true,
        embeddings: [{ id: "chunk-1", embedding: unitEmbedding }],
      });
    },
  });

  const result = await client.embed([{ id: "chunk-1", input: "TNIK fibrosis evidence" }]);
  assert.equal(result.embeddings[0].embedding.length, 384);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://project.supabase.co/functions/v1/axiom-embed");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("apikey"), "server-secret");
  assert.equal(headers.get("authorization"), "Bearer user-access-token");
  assert.equal(headers.get("x-axiom-internal-key"), "server-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    items: [{ id: "chunk-1", input: "TNIK fibrosis evidence" }],
  });
});

test("embedding response validation rejects dimension and revision drift", () => {
  assert.throws(() => validateEmbeddingResponse({
    model: "Supabase/gte-small",
    revision: "different-runtime-revision",
    dimensions: 384,
    normalized: true,
    embeddings: [{ id: "chunk-1", embedding: unitEmbedding }],
  }, new Set(["chunk-1"])), (error) => {
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.code, "invalid_embedding_response");
    return true;
  });

  assert.throws(() => validateEmbeddingResponse({
    model: "Supabase/gte-small",
    revision: "supabase-edge-runtime-managed",
    dimensions: 384,
    normalized: true,
    embeddings: [{ id: "chunk-1", embedding: [1, 0] }],
  }, new Set(["chunk-1"])), /invalid vector/i);
});

test("embedding failures are bounded and do not include source text", async () => {
  const privateInput = "private biomedical source text";
  const client = createEmbeddingClient({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    accessToken: "user-access-token",
    transport: async () => {
      const error = new Error("network stopped");
      error.name = "AbortError";
      throw error;
    },
    sleep: async () => {},
  });

  await assert.rejects(client.embed([{ id: "chunk-1", input: privateInput }]), (error) => {
    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /timed out/i);
    assert.doesNotMatch(error.message, new RegExp(privateInput));
    return true;
  });
});

test("embedding client retries transient worker responses within a fixed budget", async () => {
  let calls = 0;
  const delays = [];
  const client = createEmbeddingClient({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-secret",
    accessToken: "user-access-token",
    sleep: async (delay) => delays.push(delay),
    transport: async () => {
      calls += 1;
      if (calls < 3) return Response.json({ error: { code: "embedding_failed" } }, { status: 503 });
      return Response.json({
        model: "Supabase/gte-small",
        revision: "supabase-edge-runtime-managed",
        dimensions: 384,
        normalized: true,
        embeddings: [{ id: "chunk-1", embedding: unitEmbedding }],
      });
    },
  });

  const result = await client.embed([{ id: "chunk-1", input: "TNIK fibrosis evidence" }]);
  assert.equal(result.embeddings.length, 1);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [200, 400]);
});

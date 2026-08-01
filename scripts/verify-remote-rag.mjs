import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import worker from "../worker/index.js";

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl || !serviceRoleKey || !publishableKey) {
  throw new Error("Remote RAG verification requires the Supabase server URL, service key, and publishable key.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
let phase = "startup";
const apiEnv = {
  APP_ENV: "remote-e2e",
  ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  UPSTREAM_FETCH: async (input, init) => {
    const hostname = new URL(input).hostname;
    console.error(JSON.stringify({ phase, upstream: hostname, event: "request_started" }));
    const response = await fetch(input, init);
    console.error(JSON.stringify({ phase, upstream: hostname, event: "request_completed", status: response.status }));
    return response;
  },
};

function safeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  if (error && typeof error === "object") {
    return Object.fromEntries(Object.entries(error).map(([key, value]) => [key, String(value)]));
  }
  return { message: String(error) };
}

function disposableCredentials(label) {
  const nonce = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  return {
    email: `axiom.e2e+${label}-${nonce}@example.com`,
    password: `Ax!${randomBytes(24).toString("base64url")}9z`,
  };
}

async function createDisposableUser(label) {
  const credentials = disposableCredentials(label);
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (createError || !created.user) throw createError ?? new Error("Disposable user was not created.");

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword(credentials);
  if (signInError || !signedIn.session?.access_token) {
    await admin.auth.admin.deleteUser(created.user.id).catch(() => null);
    throw signInError ?? new Error("Disposable user could not sign in.");
  }
  return { id: created.user.id, accessToken: signedIn.session.access_token };
}

async function callApi(path, { token = null, method = "GET", body = null } = {}) {
  const response = await worker.fetch(new Request(`https://axiom-e2e.local${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  }), apiEnv);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function exactCount(table, column, value) {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  if (error) throw error;
  return count ?? 0;
}

async function cleanupUser(user) {
  if (!user?.id) return;
  const { error: workspaceError } = await admin
    .from("workspaces")
    .delete()
    .eq("created_by", user.id);
  if (workspaceError) throw workspaceError;
  const { error: userError } = await admin.auth.admin.deleteUser(user.id);
  if (userError) throw userError;
}

let owner = null;
let outsider = null;
let baselineSnapshots = null;

try {
  phase = "read_baseline";
  baselineSnapshots = await exactCount("run_snapshots", "schema_version", "1.1.0");
  phase = "create_owner";
  owner = await createDisposableUser("owner");
  phase = "create_outsider";
  outsider = await createDisposableUser("outsider");

  phase = "create_evidence_run";
  const created = await callApi("/api/runs", {
    token: owner.accessToken,
    method: "POST",
    body: {
      targetId: "ENSG00000154310",
      targetLabel: "TNIK",
      diseaseId: "EFO_0000768",
      diseaseLabel: "idiopathic pulmonary fibrosis",
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  const run = created.payload;
  assert.equal(run.schemaVersion, "2.0.0");
  assert.equal(run.rag?.status, "completed", JSON.stringify(run.rag));
  assert.equal(run.rag?.mode, "hybrid_rrf_v2");
  assert.equal(run.rag?.model, "Supabase/gte-small");
  assert.equal(run.rag?.dimensions, 384);
  assert.ok(run.rag?.counts?.chunks > 0, "The live run must create at least one chunk.");
  assert.equal(run.rag.counts.embeddedChunks, run.rag.counts.chunks);

  phase = "verify_normalized_rows";
  const tableCounts = {};
  for (const table of [
    "runs",
    "run_associations",
    "run_stages",
    "sources",
    "evidence_records",
    "literature_records",
    "documents",
    "document_chunks",
  ]) {
    phase = `verify_${table}`;
    tableCounts[table] = await exactCount(table, table === "runs" ? "id" : "run_id", run.id);
  }
  assert.equal(tableCounts.runs, 1);
  assert.equal(tableCounts.run_associations, 1);
  assert.equal(tableCounts.sources, run.rag.counts.sources);
  assert.equal(tableCounts.evidence_records, run.rag.counts.evidenceRecords);
  assert.equal(tableCounts.literature_records, run.rag.counts.literatureRecords);
  assert.equal(tableCounts.documents, run.rag.counts.documents);
  assert.equal(tableCounts.document_chunks, run.rag.counts.chunks);

  phase = "verify_chunk_provenance";
  const { data: indexedChunks, error: chunkError } = await admin
    .from("document_chunks")
    .select("id,embedding_model,embedding_revision")
    .eq("run_id", run.id);
  if (chunkError) throw chunkError;
  assert.equal(indexedChunks.length, run.rag.counts.chunks);
  assert.ok(indexedChunks.every((chunk) => chunk.embedding_model === "Supabase/gte-small"));
  assert.ok(indexedChunks.every((chunk) => chunk.embedding_revision === "supabase-edge-runtime-managed"));

  phase = "execute_hybrid_retrieval";
  const retrieved = await callApi(`/api/runs/${run.id}/retrieval`, {
    token: owner.accessToken,
    method: "POST",
    body: {
      query: "What evidence connects TNIK with pulmonary fibrosis?",
      topK: 8,
    },
  });
  assert.equal(retrieved.response.status, 200, JSON.stringify(retrieved.payload));
  assert.equal(retrieved.payload.retrievalMode, "hybrid_rrf_v2");
  assert.equal(retrieved.payload.generated, false);
  assert.equal(retrieved.payload.embedding?.model, "Supabase/gte-small");
  assert.equal(retrieved.payload.embedding?.dimensions, 384);
  assert.ok(retrieved.payload.results?.length > 0);
  assert.equal(retrieved.payload.citationAudit?.coverage, 1);
  assert.ok(retrieved.payload.results.every((result) => result.citations?.length > 0));
  assert.equal(await exactCount("retrievals", "run_id", run.id), 1);

  phase = "verify_tenant_isolation";
  const isolated = await callApi(`/api/runs/${run.id}`, { token: outsider.accessToken });
  assert.equal(isolated.response.status, 404);
  assert.equal(isolated.payload?.error?.code, "run_not_found");

  console.log(JSON.stringify({
    ok: true,
    run: {
      status: run.status,
      rag: run.rag,
      normalizedTableCounts: tableCounts,
    },
    retrieval: {
      mode: retrieved.payload.retrievalMode,
      resultCount: retrieved.payload.results.length,
      totalCandidates: retrieved.payload.totalCandidates,
      citationCoverage: retrieved.payload.citationAudit.coverage,
      workflow: retrieved.payload.workflow,
    },
    tenantIsolation: "passed",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, phase, error: safeError(error) }, null, 2));
  throw new Error(`Remote RAG verification failed during ${phase}: ${safeError(error).message || "unknown error"}`, {
    cause: error,
  });
} finally {
  phase = "cleanup";
  const cleanupErrors = [];
  for (const user of [owner, outsider]) {
    try {
      await cleanupUser(user);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (baselineSnapshots !== null) {
    const remainingBaseline = await exactCount("run_snapshots", "schema_version", "1.1.0");
    assert.equal(remainingBaseline, baselineSnapshots, "Legacy snapshots must remain unchanged by verification.");
  }
  if (cleanupErrors.length) throw new Error(`Remote verification cleanup failed: ${cleanupErrors.join("; ")}`);
}

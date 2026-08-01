import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const mockUpstream = async (input, init = {}) => {
  const url = String(input);
  if (url.includes("opentargets")) {
    const body = JSON.parse(init.body);
    if (body.query.includes("SearchEntities")) {
      const entity = body.variables.entities[0];
      return Response.json({ data: { search: { total: 1, hits: [{ id: entity === "target" ? "ENSG00000100000" : "EFO_0000001", name: entity === "target" ? "DEMO" : "Demo disease", entity, description: "Test result", score: 12.4 }] } } });
    }
    if (body.query.includes("TargetEvidence")) {
      return Response.json({ data: { target: { id: "ENSG00000100000", approvedSymbol: "DEMO", approvedName: "demo target", biotype: "protein_coding", tractability: [], associatedDiseases: { count: 1, rows: [{ disease: { id: "EFO_0000001", name: "Demo disease" }, score: 0.72, datatypeScores: [{ id: "genetic_association", score: 0.8 }], datasourceScores: [{ id: "ot_genetics_portal", score: 0.8 }] }] } } } });
    }
    if (body.query.includes("PairEvidence")) {
      return Response.json({ data: { disease: { id: "EFO_0000001", name: "Demo disease", evidences: { count: 1, cursor: null, rows: [{ id: "evidence-1", target: { id: "ENSG00000100000" }, disease: { id: "EFO_0000001" }, datatypeId: "genetic_association", datasourceId: "ot_genetics_portal", score: 0.81, literature: ["123456"], studyId: "GCST0001", variant: null, drug: null }] } } } });
    }
  }
  if (url.includes("europepmc")) {
    return Response.json({ hitCount: 1, resultList: { result: [{ pmid: "123456", doi: "10.1000/demo.1", title: "A fibrotic kinase study", abstractText: "<h4>Background</h4>This study evaluates a fibrotic disease mechanism and kinase signalling.", authorString: "A. Scientist", journalInfo: { journal: { title: "Nested Test Journal" } }, firstPublicationDate: "2025-01-01", citedByCount: 4, isOpenAccess: "Y" }] } });
  }
  return new Response("unhandled", { status: 500 });
};

const env = {
  APP_ENV: "test",
  UPSTREAM_FETCH: mockUpstream,
  ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
};

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_ACCESS_TOKEN = "test-access-token";

const authRequest = (url, init = {}) => new Request(url, {
  ...init,
  headers: {
    ...(init.body ? { "content-type": "application/json" } : {}),
    authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
    ...init.headers,
  },
});

const mockAuth = async (input, init = {}) => {
  const url = new URL(input);
  const headers = new Headers(init.headers);
  assert.equal(url.pathname, "/auth/v1/user");
  assert.equal(headers.get("apikey"), "test-service-role-key");
  assert.equal(headers.get("authorization"), `Bearer ${TEST_ACCESS_TOKEN}`);
  return Response.json({ id: TEST_USER_ID, email: "researcher@example.test" });
};

async function createDemoRun() {
  const response = await worker.fetch(new Request("https://example.test/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: "ENSG00000100000", targetLabel: "DEMO", diseaseId: "EFO_0000001", diseaseLabel: "Demo disease" }),
  }), env);
  assert.equal(response.status, 201);
  return response.json();
}

test("health reports honest capability and persistence states", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/health"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.capabilities.openTargets, true);
  assert.equal(body.capabilities.retrieval, true);
  assert.equal(body.capabilities.generation, false);
  assert.equal(body.capabilities.docking, false);
  assert.deepEqual(body.persistence, {
    mode: "ephemeral_memory",
    durable: false,
    configured: false,
    available: true,
  });
});

test("entity search preserves upstream rank without calling it confidence", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/targets/search?q=demo"), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items[0].id, "ENSG00000100000");
  assert.equal(body.items[0].searchRankScore, 12.4);
  assert.match(body.items[0].scoreNote, /not scientific confidence/i);
});

test("run creation normalizes live evidence, literature and provenance", async () => {
  const run = await createDemoRun();
  assert.equal(run.status, "evidence_ready");
  assert.equal(run.association.associationScore, 0.72);
  assert.match(run.association.scoreNote, /not a confidence/i);
  assert.equal(run.evidence.items[0].datasourceId, "ot_genetics_portal");
  assert.equal(run.literature.items[0].pmid, "123456");
  assert.equal(run.literature.items[0].doi, "10.1000/demo.1");
  assert.equal(run.literature.items[0].abstractText, "Background This study evaluates a fibrotic disease mechanism and kinase signalling.");
  assert.equal(run.literature.items[0].journal, "Nested Test Journal");
  assert.equal(run.capabilities.admet, false);
  assert.equal(run.provenance.length, 2);

  const stored = await worker.fetch(new Request(`https://example.test/api/runs/${run.id}`), env);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).id, run.id);
});

test("invalid run input fails closed", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: "ENSG00000100000" }),
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_input");
});

test("retrieval ranks run evidence without generating an answer", async () => {
  const run = await createDemoRun();
  const response = await worker.fetch(new Request(`https://example.test/api/runs/${run.id}/retrieval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "fibrotic kinase", topK: 1 }),
  }), env);
  const retrieval = await response.json();

  assert.equal(response.status, 200);
  assert.equal(retrieval.query, "fibrotic kinase");
  assert.equal(retrieval.retrievalMode, "lexical_rank_v1");
  assert.equal(retrieval.generated, false);
  assert.equal(retrieval.totalCandidates, 2);
  assert.equal(retrieval.results.length, 1);
  assert.equal(retrieval.results[0].id, "PMID:123456");
  assert.equal(retrieval.results[0].sourceType, "europe_pmc_literature");
  assert.match(retrieval.results[0].excerpt, /fibrotic disease mechanism/i);
  assert.ok(retrieval.results[0].score > 0);
  assert.match(retrieval.results[0].scoreMeaning, /not probability or confidence/i);
  assert.equal(retrieval.results[0].sourceUrl, "https://europepmc.org/article/MED/123456");
  assert.deepEqual(retrieval.results[0].citations, ["PMID:123456", "DOI:10.1000/demo.1"]);
  assert.equal(retrieval.results[0].provenance.sourceId, "europe-pmc");
  assert.match(retrieval.warnings.join(" "), /not a generated answer/i);

  const evidenceResponse = await worker.fetch(new Request(`https://example.test/api/runs/${run.id}/retrieval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "genetic GCST0001" }),
  }), env);
  const evidenceRetrieval = await evidenceResponse.json();
  assert.equal(evidenceResponse.status, 200);
  assert.equal(evidenceRetrieval.results[0].id, "evidence-1");
  assert.equal(evidenceRetrieval.results[0].sourceType, "open_targets_direct_evidence");
  assert.equal(evidenceRetrieval.results[0].provenance.studyId, "GCST0001");
  assert.ok(evidenceRetrieval.results[0].citations.includes("PMID:123456"));
});

test("retrieval validates query and topK", async () => {
  const run = await createDemoRun();
  const invalidCases = [
    { body: { query: "ab" }, message: /query must be between 3 and 500/i },
    { body: { query: "valid query", topK: 0 }, message: /topK must be an integer between 1 and 20/i },
    { body: { query: "valid query", topK: 1.5 }, message: /topK must be an integer between 1 and 20/i },
  ];

  for (const invalidCase of invalidCases) {
    const response = await worker.fetch(new Request(`https://example.test/api/runs/${run.id}/retrieval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidCase.body),
    }), env);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "invalid_input");
    assert.match(body.error.message, invalidCase.message);
  }
});

test("retrieval returns a structured 404 for a missing ephemeral run", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/runs/not-a-run/retrieval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "fibrotic kinase" }),
  }), env);
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "run_not_found");
  assert.match(body.error.message, /ephemeral store/i);
});

function createSupabaseMock() {
  const snapshots = new Map();
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    requests.push({ url, method: init.method ?? "GET", headers, body: init.body ?? null });
    assert.equal(headers.get("apikey"), "test-service-role-key");
    assert.equal(headers.get("accept-profile"), "public");

    if (url.pathname === "/rest/v1/rpc/ensure_default_workspace") {
      assert.equal(init.method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${TEST_ACCESS_TOKEN}`);
      assert.equal(init.body, "{}");
      return Response.json(TEST_WORKSPACE_ID);
    }

    assert.equal(url.pathname, "/rest/v1/run_snapshots");
    const isHealthProbe = init.method === "GET" && !url.searchParams.has("id");
    assert.equal(headers.get("authorization"), isHealthProbe ? "Bearer test-service-role-key" : `Bearer ${TEST_ACCESS_TOKEN}`);

    if (init.method === "POST") {
      assert.equal(url.searchParams.get("on_conflict"), "id");
      assert.equal(headers.get("content-profile"), "public");
      assert.match(headers.get("prefer"), /resolution=merge-duplicates/);
      const row = JSON.parse(init.body);
      assert.equal(row.workspace_id, TEST_WORKSPACE_ID);
      assert.equal(row.created_by, TEST_USER_ID);
      snapshots.set(row.id, row);
      return new Response(null, { status: 201 });
    }

    const filter = url.searchParams.get("id");
    const id = filter?.startsWith("eq.") ? filter.slice(3) : null;
    const row = id ? snapshots.get(id) : null;
    return Response.json(row ? [{ snapshot: row.snapshot }] : []);
  };
  return { fetch, requests, snapshots };
}

test("Supabase repository persists and retrieves the durable run snapshot", async () => {
  const supabase = createSupabaseMock();
  const supabaseEnv = {
    ...env,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_FETCH: supabase.fetch,
    AUTH_FETCH: mockAuth,
  };

  const healthResponse = await worker.fetch(new Request("https://example.test/api/health"), supabaseEnv);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.deepEqual(health.persistence, {
    mode: "supabase_postgres",
    durable: true,
    configured: true,
    available: true,
  });
  assert.equal(health.authRequired, true);

  const createResponse = await worker.fetch(authRequest("https://example.test/api/runs", {
    method: "POST",
    body: JSON.stringify({
      targetId: "ENSG00000100000",
      targetLabel: "DEMO",
      diseaseId: "EFO_0000001",
      diseaseLabel: "Demo disease",
    }),
  }), supabaseEnv);
  const run = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.deepEqual(run.persistence, health.persistence);
  assert.equal(run.workspaceId, TEST_WORKSPACE_ID);
  assert.equal(run.createdBy, TEST_USER_ID);
  assert.doesNotMatch(run.warnings.join(" "), /ephemeral/i);
  assert.equal(supabase.snapshots.get(run.id).snapshot.id, run.id);
  assert.deepEqual(supabase.snapshots.get(run.id).snapshot.persistence, health.persistence);

  const readResponse = await worker.fetch(authRequest(`https://example.test/api/runs/${run.id}`), supabaseEnv);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), run);
  assert.deepEqual(supabase.requests.map((request) => request.method), ["GET", "POST", "POST", "GET"]);
  assert.doesNotMatch(JSON.stringify(health), /test-service-role-key/);
  assert.doesNotMatch(JSON.stringify(run), /test-service-role-key/);
});

test("configured Supabase failures do not fall back to process memory", async () => {
  const failingEnv = {
    ...env,
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_FETCH: async () => Response.json({ message: "database unavailable" }, { status: 503 }),
    AUTH_FETCH: mockAuth,
  };
  const healthResponse = await worker.fetch(new Request("https://example.test/api/health"), failingEnv);
  const health = await healthResponse.json();
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.persistence, {
    mode: "supabase_postgres",
    durable: false,
    configured: true,
    available: false,
  });
  assert.equal(health.authRequired, true);

  const createResponse = await worker.fetch(authRequest("https://example.test/api/runs", {
    method: "POST",
    body: JSON.stringify({ targetId: "ENSG00000100000", diseaseId: "EFO_0000001" }),
  }), failingEnv);
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 503);
  assert.equal(createBody.error.code, "persistence_unavailable");
  assert.equal(createBody.error.details.operation, "workspace");
  assert.equal(createBody.error.details.upstreamStatus, 503);
  assert.doesNotMatch(JSON.stringify(createBody), /test-service-role-key/);

  const readResponse = await worker.fetch(authRequest("https://example.test/api/runs/missing"), failingEnv);
  const readBody = await readResponse.json();
  assert.equal(readResponse.status, 503);
  assert.equal(readBody.error.code, "persistence_unavailable");
  assert.equal(readBody.error.details.operation, "read");
});

test("partial Supabase configuration reports degraded and fails closed", async () => {
  const partialEnv = { ...env, SUPABASE_URL: "https://project.supabase.co" };
  const healthResponse = await worker.fetch(new Request("https://example.test/api/health"), partialEnv);
  const health = await healthResponse.json();
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.persistence, {
    mode: "supabase_postgres",
    durable: false,
    configured: false,
    available: false,
  });

  const readResponse = await worker.fetch(new Request("https://example.test/api/runs/missing"), partialEnv);
  const body = await readResponse.json();
  assert.equal(readResponse.status, 503);
  assert.equal(body.error.code, "persistence_unavailable");
});

test("durable run routes require a valid Supabase session before upstream work", async () => {
  const supabase = createSupabaseMock();
  let upstreamCalls = 0;
  const protectedEnv = {
    ...env,
    UPSTREAM_FETCH: async (...args) => { upstreamCalls += 1; return mockUpstream(...args); },
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_FETCH: supabase.fetch,
    AUTH_FETCH: async () => Response.json({ message: "invalid token" }, { status: 401 }),
  };

  const missingToken = await worker.fetch(new Request("https://example.test/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: "ENSG00000100000", diseaseId: "EFO_0000001" }),
  }), protectedEnv);
  assert.equal(missingToken.status, 401);
  assert.equal((await missingToken.json()).error.code, "authentication_required");

  const invalidToken = await worker.fetch(authRequest("https://example.test/api/runs/missing"), protectedEnv);
  assert.equal(invalidToken.status, 401);
  assert.equal((await invalidToken.json()).error.code, "invalid_session");
  assert.equal(upstreamCalls, 0);
});

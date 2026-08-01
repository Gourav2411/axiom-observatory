const OPEN_TARGETS_URL = "https://api.platform.opentargets.org/api/v4/graphql";
const EUROPE_PMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const RUN_SCHEMA_VERSION = "2.0.0";
import { PersistenceError, createRunRepository } from "./run-repository.js";
import {
  CHUNKING_STRATEGY,
  CHUNK_MAX_WORDS,
  CHUNK_OVERLAP_WORDS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  buildNormalizedRunPayload,
} from "./rag-pipeline.js";

class AuthenticationError extends Error {
  constructor(message, code = "authentication_required") {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

const SEARCH_QUERY = `
  query SearchEntities($query: String!, $entities: [String!]!) {
    search(queryString: $query, entityNames: $entities, page: { index: 0, size: 12 }) {
      total
      hits { id name entity description score }
    }
  }
`;

const TARGET_EVIDENCE_QUERY = `
  query TargetEvidence($targetId: String!) {
    target(ensemblId: $targetId) {
      id
      approvedSymbol
      approvedName
      biotype
      tractability { label modality value }
      associatedDiseases(page: { index: 0, size: 200 }, enableIndirect: false) {
        count
        rows {
          disease { id name }
          score
          datatypeScores { id score }
          datasourceScores { id score }
        }
      }
    }
  }
`;

const PAIR_EVIDENCE_QUERY = `
  query PairEvidence($targetId: String!, $diseaseId: String!) {
    disease(efoId: $diseaseId) {
      id
      name
      evidences(ensemblIds: [$targetId], size: 100) {
        count
        cursor
        rows {
          id
          target { id }
          disease { id }
          datatypeId
          datasourceId
          score
          literature
          studyId
          variant { id }
          drug { id }
        }
      }
    }
  }
`;

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function apiError(code, message, status = 500, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

function handledInfrastructureError(error) {
  if (error instanceof AuthenticationError) {
    return apiError(error.code, error.message, 401);
  }
  if (error instanceof PersistenceError) {
    if (error.status === 401 || error.status === 403) {
      return apiError("invalid_session", "Your Supabase session is invalid, expired, or not authorized", 401);
    }
    return apiError("persistence_unavailable", "Durable run storage is unavailable", 503, {
      operation: error.operation,
      ...(error.status ? { upstreamStatus: error.status } : {}),
    });
  }
  return null;
}

async function fetchWithTimeout(transport, url, init = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Upstream request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function authenticateSupabaseRequest(request, env) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new AuthenticationError("Sign in with Supabase to access durable evidence runs");
  }

  let userEndpoint;
  try {
    userEndpoint = new URL("/auth/v1/user", `${env.SUPABASE_URL.replace(/\/+$/, "")}/`);
  } catch (error) {
    throw new PersistenceError("Supabase authentication URL is invalid", { operation: "authorize", cause: error });
  }

  const transport = env.AUTH_FETCH ?? globalThis.fetch;
  let response;
  try {
    response = await fetchWithTimeout(transport, userEndpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization,
      },
    }, 8_000);
  } catch (error) {
    throw new PersistenceError("Supabase authentication is unavailable", { operation: "authorize", cause: error });
  }
  if (!response.ok) throw new AuthenticationError("Your Supabase session is invalid or expired", "invalid_session");

  let user;
  try {
    user = await response.json();
  } catch {
    throw new AuthenticationError("Supabase returned an invalid user session", "invalid_session");
  }
  if (typeof user?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(user.id)) {
    throw new AuthenticationError("Supabase returned an invalid user session", "invalid_session");
  }
  return { userId: user.id, accessToken: authorization.replace(/^Bearer\s+/i, "") };
}

async function repositoryForRequest(request, env, baseRepository) {
  if (baseRepository.persistence.mode === "ephemeral_memory") return baseRepository;
  if (!baseRepository.persistence.configured) {
    throw new PersistenceError("Supabase persistence configuration is incomplete", { operation: "configure" });
  }
  return createRunRepository(env, await authenticateSupabaseRequest(request, env));
}

async function openTargets(transport, query, variables) {
  const response = await fetchWithTimeout(transport, OPEN_TARGETS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Open Targets returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(`Open Targets GraphQL: ${payload.errors[0].message}`);
  return payload.data;
}

async function searchEntities(transport, query, entity) {
  const data = await openTargets(transport, SEARCH_QUERY, { query, entities: [entity] });
  return {
    total: data.search?.total ?? 0,
    items: (data.search?.hits ?? []).map((hit) => ({
      id: hit.id,
      label: hit.name,
      entityType: hit.entity,
      description: hit.description ?? null,
      searchRankScore: hit.score ?? null,
      scoreNote: "Open Targets search relevance score; not scientific confidence.",
    })),
  };
}

function cleanSourceText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function europePmcSearch(transport, query) {
  const url = new URL(EUROPE_PMC_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "25");
  url.searchParams.set("sort", "CITED desc");
  const response = await fetchWithTimeout(transport, url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Europe PMC returned HTTP ${response.status}`);
  const payload = await response.json();
  const results = payload.resultList?.result ?? [];
  return {
    query,
    hitCount: Number(payload.hitCount ?? results.length),
    items: results.map((item) => ({
      id: item.pmid ? `PMID:${item.pmid}` : item.pmcid ? `PMCID:${item.pmcid}` : `${item.source}:${item.id}`,
      pmid: item.pmid ?? null,
      pmcid: item.pmcid ?? null,
      doi: item.doi ?? null,
      title: item.title ?? "Untitled result",
      abstractText: cleanSourceText(item.abstractText),
      authors: item.authorString ?? null,
      journal: item.journalInfo?.journal?.title ?? item.journalTitle ?? null,
      publicationDate: item.firstPublicationDate ?? item.journalInfo?.printPublicationDate ?? null,
      citedByCount: Number(item.citedByCount ?? 0),
      isOpenAccess: item.isOpenAccess === "Y",
      evidenceKind: "literature_record",
      sourceUrl: item.pmid
        ? `https://europepmc.org/article/MED/${item.pmid}`
        : item.pmcid
          ? `https://europepmc.org/article/PMC/${item.pmcid}`
          : item.source && item.id
            ? `https://europepmc.org/article/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}`
            : null,
    })),
  };
}

function lexicalTokens(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function termCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function excerptAroundMatch(value, queryTokens, maxLength = 360) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const lower = text.toLocaleLowerCase("en");
  const positions = queryTokens.map((token) => lower.indexOf(token)).filter((position) => position >= 0);
  const firstMatch = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, firstMatch - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function literatureCandidate(item) {
  const identifiers = [item.id];
  if (item.doi) identifiers.push(`DOI:${item.doi}`);
  return {
    id: item.id,
    sourceType: "europe_pmc_literature",
    title: item.title,
    body: [item.abstractText, item.authors, item.journal, item.publicationDate].filter(Boolean).join(". "),
    sourceUrl: item.sourceUrl,
    citations: identifiers,
    provenance: {
      sourceId: "europe-pmc",
      recordId: item.id,
      pmid: item.pmid,
      pmcid: item.pmcid,
      doi: item.doi,
    },
  };
}

function evidenceCandidate(item) {
  const titleParts = [item.datatypeId, "evidence"];
  if (item.datasourceId) titleParts.push(`from ${item.datasourceId}`);
  const identifiers = [item.id, ...(item.literatureIds ?? []).map((id) => `PMID:${id}`)];
  for (const [prefix, value] of [["study", item.studyId], ["variant", item.variantId], ["drug", item.drugId]]) {
    if (value) identifiers.push(`${prefix}:${value}`);
  }
  return {
    id: item.id,
    sourceType: "open_targets_direct_evidence",
    title: titleParts.filter(Boolean).join(" "),
    body: [
      `Target ${item.targetId}`,
      `disease ${item.diseaseId}`,
      item.studyId ? `study ${item.studyId}` : null,
      item.variantId ? `variant ${item.variantId}` : null,
      item.drugId ? `drug ${item.drugId}` : null,
      item.literatureIds?.length ? `literature ${item.literatureIds.join(" ")}` : null,
    ].filter(Boolean).join(". "),
    sourceUrl: `https://platform.opentargets.org/evidence/${encodeURIComponent(item.targetId)}/${encodeURIComponent(item.diseaseId)}`,
    citations: identifiers,
    provenance: {
      sourceId: "open-targets-platform",
      recordId: item.id,
      datasourceId: item.datasourceId ?? null,
      datatypeId: item.datatypeId ?? null,
      studyId: item.studyId ?? null,
      variantId: item.variantId ?? null,
      drugId: item.drugId ?? null,
      literatureIds: item.literatureIds ?? [],
    },
  };
}

function lexicalRetrieve(run, query, topK) {
  const queryTokens = [...new Set(lexicalTokens(query))];
  const candidates = [
    ...(run.literature?.items ?? []).map(literatureCandidate),
    ...(run.evidence?.items ?? []).map(evidenceCandidate),
  ];
  const indexed = candidates.map((candidate) => {
    const titleTokens = lexicalTokens(candidate.title);
    const bodyTokens = lexicalTokens(candidate.body);
    return {
      ...candidate,
      titleCounts: termCounts(titleTokens),
      bodyCounts: termCounts(bodyTokens),
      documentTokens: new Set([...titleTokens, ...bodyTokens]),
    };
  });
  const documentFrequency = new Map(queryTokens.map((token) => [
    token,
    indexed.filter((candidate) => candidate.documentTokens.has(token)).length,
  ]));

  const results = indexed.map((candidate) => {
    let lexicalScore = 0;
    for (const token of queryTokens) {
      const titleFrequency = candidate.titleCounts.get(token) ?? 0;
      const bodyFrequency = candidate.bodyCounts.get(token) ?? 0;
      if (!titleFrequency && !bodyFrequency) continue;
      const inverseDocumentFrequency = Math.log(1 + (indexed.length + 1) / ((documentFrequency.get(token) ?? 0) + 1));
      lexicalScore += inverseDocumentFrequency * (titleFrequency * 3 + Math.log1p(bodyFrequency));
    }
    const excerptSource = candidate.body || candidate.title;
    return {
      id: candidate.id,
      sourceType: candidate.sourceType,
      title: candidate.title,
      excerpt: excerptAroundMatch(excerptSource, queryTokens),
      score: Number(lexicalScore.toFixed(6)),
      scoreMeaning: "Deterministic lexical relevance rank; not probability or confidence.",
      sourceUrl: candidate.sourceUrl,
      citations: candidate.citations,
      provenance: candidate.provenance,
    };
  }).filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score
      || left.sourceType.localeCompare(right.sourceType)
      || left.id.localeCompare(right.id))
    .slice(0, topK)
    .map((result, index) => ({
      ...result,
      ranks: { lexical: index + 1, semantic: null },
      scores: { lexical: result.score, vector: null, fused: result.score },
    }));

  const warnings = [
    "Results are lexical retrieval records, not a generated answer or scientific conclusion.",
    "Lexical relevance scores are ranking values, not probabilities or confidence estimates.",
  ];
  if (!results.length) warnings.push("No candidate contained a query term.");
  const citedResults = results.filter((result) => result.citations?.length).length;
  return {
    query,
    retrievalMode: "lexical_rank_v1",
    generated: false,
    totalCandidates: candidates.length,
    embedding: null,
    workflow: [
      { step: "planner", label: "Query planner", status: "completed" },
      { step: "lexical_retriever", label: "Lexical retriever", status: "completed" },
      { step: "citation_guard", label: "Citation guard", status: "completed" },
    ],
    results,
    citationAudit: {
      status: citedResults === results.length ? "passed" : "incomplete",
      coverage: results.length ? citedResults / results.length : 1,
      citedResults,
      totalResults: results.length,
    },
    warnings,
  };
}

function createStage(id, label, service, status, extra = {}) {
  return { id, label, service, status, ...extra };
}

function unavailableStages() {
  return [
    createStage("docking", "Docking validation", "No worker configured", "not_configured", {
      evidenceKind: "computational_prediction",
      reason: "Install and register an open-source docking worker before this stage can run.",
    }),
    createStage("safety", "ADMET and toxicity", "No worker configured", "not_configured", {
      evidenceKind: "computational_prediction",
      reason: "Install and register ADMET-AI before this stage can run.",
    }),
    createStage("synthesis", "Retrosynthesis", "No worker configured", "not_configured", {
      evidenceKind: "computational_prediction",
      reason: "Install and register AiZynthFinder before this stage can run.",
    }),
  ];
}

function ragIndexStage(durable) {
  return createStage(
    "rag_index",
    "Hybrid RAG index",
    durable ? "Supabase gte-small + pgvector" : "Durable Supabase required",
    durable ? "pending" : "not_configured",
    {
      evidenceKind: "retrieval_index",
      model: durable ? EMBEDDING_MODEL : null,
      revision: durable ? EMBEDDING_REVISION : null,
      dimensions: durable ? EMBEDDING_DIMENSIONS : null,
      reason: durable ? null : "Configure durable Supabase persistence to build the normalized hybrid index.",
    },
  );
}

function initialRagState(durable) {
  return {
    status: durable ? "pending" : "lexical_only",
    mode: durable ? "normalizing" : "lexical_rank_v1",
    model: durable ? EMBEDDING_MODEL : null,
    revision: durable ? EMBEDDING_REVISION : null,
    dimensions: durable ? EMBEDDING_DIMENSIONS : null,
    normalized: durable ? true : null,
    counts: {
      sources: 0,
      evidenceRecords: 0,
      literatureRecords: 0,
      documents: 0,
      chunks: 0,
      embeddedChunks: 0,
    },
    chunking: {
      strategy: CHUNKING_STRATEGY,
      maxWords: CHUNK_MAX_WORDS,
      overlapWords: CHUNK_OVERLAP_WORDS,
    },
    fallbackReason: durable ? null : "Hybrid retrieval requires the normalized Supabase index.",
  };
}

async function persistAndIndexRun(run, repository) {
  run.stages = Array.isArray(run.stages) ? run.stages : [];
  run.warnings = Array.isArray(run.warnings) ? run.warnings : [];
  run.capabilities = run.capabilities && typeof run.capabilities === "object"
    ? run.capabilities
    : { retrieval: true };
  if (!run.stages.some((stage) => stage.id === "rag_index")) {
    const firstUnavailable = run.stages.findIndex((stage) => stage.status === "not_configured");
    const insertAt = firstUnavailable >= 0 ? firstUnavailable : run.stages.length;
    run.stages.splice(insertAt, 0, ragIndexStage(repository.persistence.durable));
  }
  run.rag = initialRagState(repository.persistence.durable);

  if (!repository.persistence.durable) {
    run.capabilities.hybridRetrieval = false;
    run.capabilities.openSourceEmbeddings = false;
    return repository.put(run);
  }

  const normalized = await buildNormalizedRunPayload(run);
  run.rag = {
    ...run.rag,
    status: "indexing",
    mode: "postgres_fts_v1",
    counts: normalized.counts,
  };
  await repository.ingest(run, normalized.payload);

  const stage = run.stages.find((item) => item.id === "rag_index");
  try {
    const indexSummary = await repository.index(run.id);
    const embeddedChunks = Number(
      indexSummary.embeddedChunks
      ?? indexSummary.embedded_chunks
      ?? normalized.counts.chunks,
    );
    run.rag = {
      ...run.rag,
      status: "completed",
      mode: "hybrid_rrf_v2",
      counts: { ...run.rag.counts, embeddedChunks },
      fallbackReason: null,
    };
    Object.assign(stage, {
      status: "completed",
      itemCount: embeddedChunks,
      totalChunks: normalized.counts.chunks,
      evidenceKind: "retrieval_index",
    });
    run.capabilities.hybridRetrieval = true;
    run.capabilities.openSourceEmbeddings = true;
  } catch (error) {
    const failure = {
      code: typeof error?.code === "string" && /^[a-z0-9_]+$/i.test(error.code)
        ? error.code
        : "rag_index_unavailable",
      ...(Number.isInteger(error?.status) ? { upstreamStatus: error.status } : {}),
    };
    run.rag = {
      ...run.rag,
      status: "failed",
      mode: "postgres_fts_v1",
      fallbackReason: "The open-source embedding index is unavailable; database lexical retrieval remains available.",
      failure,
    };
    Object.assign(stage, {
      status: "failed",
      error: failure,
    });
    run.capabilities.hybridRetrieval = false;
    run.capabilities.openSourceEmbeddings = false;
    run.warnings.push("Hybrid indexing did not complete. Retrieval will use the normalized Postgres lexical index until indexing succeeds.");
  }
  run.updatedAt = new Date().toISOString();
  return repository.put(run);
}

async function createRun(transport, input, appEnv, repository) {
  const ownership = await repository.prepare();
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const warnings = [
    "Open Targets association scores are ranking signals, not confidence estimates.",
    "Literature retrieval is evidence discovery, not automated causal validation.",
  ];
  if (!repository.persistence.durable) {
    warnings.push("This local run store is ephemeral and resets with the server process.");
  }
  const provenance = [];
  const stages = [];
  let targetData = null;
  let literature = { query: null, hitCount: 0, items: [] };
  let association = null;
  let evidence = { count: 0, cursor: null, items: [] };

  try {
    const ot = await openTargets(transport, TARGET_EVIDENCE_QUERY, { targetId: input.targetId });
    targetData = ot.target;
    if (!targetData) throw new Error("Target was not found in Open Targets");
    const matched = targetData.associatedDiseases?.rows?.find((row) => row.disease?.id === input.diseaseId);
    association = matched ? {
      targetId: input.targetId,
      diseaseId: input.diseaseId,
      associationScore: matched.score,
      datatypeScores: matched.datatypeScores ?? [],
      datasourceScores: matched.datasourceScores ?? [],
      evidenceKind: "aggregated_target_disease_association",
      scoreNote: "Open Targets association score is a relative ranking signal, not a confidence probability.",
      directMatch: true,
    } : {
      targetId: input.targetId,
      diseaseId: input.diseaseId,
      associationScore: null,
      datatypeScores: [],
      datasourceScores: [],
      evidenceKind: "aggregated_target_disease_association",
      scoreNote: "No direct association was present in the first 200 target-associated disease rows.",
      directMatch: false,
    };
    stages.push(createStage("evidence", "Target evidence", "Open Targets", "completed", {
      evidenceKind: "aggregated_target_disease_association",
      itemCount: targetData.associatedDiseases?.count ?? 0,
    }));
    provenance.push({
      sourceId: "open-targets-platform",
      sourceName: "Open Targets Platform",
      endpoint: OPEN_TARGETS_URL,
      retrievedAt: new Date().toISOString(),
      license: "CC0-1.0 data / Apache-2.0 code",
      queryType: "target and associated diseases",
    });

    try {
      const pairData = await openTargets(transport, PAIR_EVIDENCE_QUERY, {
        targetId: input.targetId,
        diseaseId: input.diseaseId,
      });
      const upstreamEvidence = pairData.disease?.evidences;
      evidence = {
        count: upstreamEvidence?.count ?? 0,
        cursor: upstreamEvidence?.cursor ?? null,
        items: (upstreamEvidence?.rows ?? []).map((row, index) => ({
          id: row.id ?? `${row.datasourceId ?? "unknown"}:${row.studyId ?? row.variant?.id ?? row.drug?.id ?? index}`,
          targetId: row.target?.id ?? input.targetId,
          diseaseId: row.disease?.id ?? input.diseaseId,
          datatypeId: row.datatypeId,
          datasourceId: row.datasourceId,
          upstreamScore: row.score ?? null,
          literatureIds: row.literature ?? [],
          studyId: row.studyId ?? null,
          variantId: row.variant?.id ?? null,
          drugId: row.drug?.id ?? null,
          evidenceKind: "open_targets_evidence_record",
        })),
        pageNote: "First 100 direct evidence records; cursor is retained when more records are available.",
      };
      stages[stages.length - 1].itemCount = evidence.items.length;
      stages[stages.length - 1].totalEvidenceCount = evidence.count;
    } catch (error) {
      warnings.push(`Open Targets pair-evidence retrieval failed: ${error.message}`);
    }
  } catch (error) {
    stages.push(createStage("evidence", "Target evidence", "Open Targets", "failed", { error: error.message }));
    warnings.push(`Open Targets retrieval failed: ${error.message}`);
  }

  const targetLabel = targetData?.approvedSymbol ?? input.targetLabel ?? input.targetId;
  const diseaseLabel = input.diseaseLabel ?? input.diseaseId;
  const literatureQuery = `(${targetLabel} OR "${targetData?.approvedName ?? targetLabel}") AND "${diseaseLabel}"`;
  try {
    literature = await europePmcSearch(transport, literatureQuery);
    stages.push(createStage("literature", "Literature retrieval", "Europe PMC", "completed", {
      evidenceKind: "literature_record",
      itemCount: literature.items.length,
      totalHits: literature.hitCount,
    }));
    provenance.push({
      sourceId: "europe-pmc",
      sourceName: "Europe PMC",
      endpoint: EUROPE_PMC_URL,
      retrievedAt: new Date().toISOString(),
      license: "Europe PMC terms; article-level reuse varies",
      query: literatureQuery,
    });
  } catch (error) {
    stages.push(createStage("literature", "Literature retrieval", "Europe PMC", "failed", { error: error.message }));
    warnings.push(`Europe PMC retrieval failed: ${error.message}`);
  }

  stages.push(ragIndexStage(repository.persistence.durable), ...unavailableStages());
  const completedSources = stages.filter((stage) => stage.status === "completed").length;
  const run = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id,
    status: completedSources === 2 ? "evidence_ready" : completedSources ? "partial" : "failed",
    createdAt,
    updatedAt: new Date().toISOString(),
    environment: appEnv ?? "production",
    persistence: repository.persistence,
    ...(ownership ?? {}),
    target: {
      id: input.targetId,
      label: targetData?.approvedSymbol ?? input.targetLabel ?? input.targetId,
      name: targetData?.approvedName ?? null,
      biotype: targetData?.biotype ?? null,
      tractability: targetData?.tractability ?? [],
    },
    disease: { id: input.diseaseId, label: diseaseLabel },
    association,
    evidence,
    literature,
    stages,
    provenance,
    capabilities: {
      openTargets: true,
      europePmc: true,
      retrieval: true,
      hybridRetrieval: false,
      openSourceEmbeddings: false,
      docking: false,
      admet: false,
      retrosynthesis: false,
      generation: false,
    },
    rag: initialRagState(repository.persistence.durable),
    warnings,
  };
  return persistAndIndexRun(run, repository);
}

function validateRunInput(value) {
  if (!value || typeof value !== "object") return "JSON body is required";
  if (!value.targetId || typeof value.targetId !== "string") return "targetId is required";
  if (!value.diseaseId || typeof value.diseaseId !== "string") return "diseaseId is required";
  return null;
}

function validateRetrievalInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "JSON body is required";
  if (typeof value.query !== "string") return "query must be a string between 3 and 500 characters";
  const query = value.query.trim();
  if (query.length < 3 || query.length > 500) return "query must be between 3 and 500 characters after trimming";
  if (!lexicalTokens(query).length) return "query must contain at least one letter or number";
  if (value.topK !== undefined && (!Number.isInteger(value.topK) || value.topK < 1 || value.topK > 20)) {
    return "topK must be an integer between 1 and 20";
  }
  return null;
}

async function handleApi(request, env = {}) {
  const url = new URL(request.url);
  const transport = env.UPSTREAM_FETCH ?? globalThis.fetch;
  const baseRepository = createRunRepository(env);
  if (url.pathname === "/api/health" && request.method === "GET") {
    const persistence = await baseRepository.health();
    const hybridConfigured = persistence.mode === "supabase_postgres"
      && persistence.configured
      && persistence.available;
    return json({
      status: persistence.available === false ? "degraded" : "ok",
      service: "axiom-evidence-api",
      schemaVersion: RUN_SCHEMA_VERSION,
      persistence,
      authRequired: persistence.mode === "supabase_postgres" && persistence.configured,
      capabilities: {
        openTargets: true,
        europePmc: true,
        retrieval: true,
        hybridRetrieval: hybridConfigured,
        openSourceEmbeddings: hybridConfigured,
        docking: false,
        admet: false,
        retrosynthesis: false,
        generation: false,
      },
      rag: {
        defaultMode: hybridConfigured ? "hybrid_rrf_v2" : "lexical_rank_v1",
        model: hybridConfigured ? EMBEDDING_MODEL : null,
        revision: hybridConfigured ? EMBEDDING_REVISION : null,
        dimensions: hybridConfigured ? EMBEDDING_DIMENSIONS : null,
        generated: false,
      },
    });
  }

  if (["/api/targets/search", "/api/diseases/search"].includes(url.pathname) && request.method === "GET") {
    const query = url.searchParams.get("q")?.trim();
    if (!query || query.length < 2) return apiError("invalid_query", "q must contain at least 2 characters", 400);
    const entity = url.pathname.includes("diseases") ? "disease" : "target";
    try {
      return json(await searchEntities(transport, query, entity));
    } catch (error) {
      return apiError("upstream_unavailable", error.message, 502, { source: "Open Targets" });
    }
  }

  if (url.pathname === "/api/runs" && request.method === "POST") {
    let input;
    try { input = await request.json(); } catch { return apiError("invalid_json", "Request body must be valid JSON", 400); }
    const validationError = validateRunInput(input);
    if (validationError) return apiError("invalid_input", validationError, 400);
    try {
      const repository = await repositoryForRequest(request, env, baseRepository);
      const run = await createRun(transport, input, env.APP_ENV, repository);
      return json(run, 201, { location: `/api/runs/${run.id}` });
    } catch (error) {
      const handled = handledInfrastructureError(error);
      if (handled) return handled;
      throw error;
    }
  }

  const retrievalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/retrieval$/);
  if (retrievalMatch && request.method === "POST") {
    let run;
    let repository;
    try {
      repository = await repositoryForRequest(request, env, baseRepository);
      run = await repository.get(retrievalMatch[1]);
    } catch (error) {
      const handled = handledInfrastructureError(error);
      if (handled) return handled;
      throw error;
    }
    if (!run) {
      const message = baseRepository.persistence.mode === "ephemeral_memory"
        ? "Run does not exist or the ephemeral store was reset"
        : "Run does not exist";
      return apiError("run_not_found", message, 404);
    }
    let input;
    try { input = await request.json(); } catch { return apiError("invalid_json", "Request body must be valid JSON", 400); }
    const validationError = validateRetrievalInput(input);
    if (validationError) return apiError("invalid_input", validationError, 400);
    const query = input.query.trim();
    if (repository.persistence.durable) {
      try {
        if (run.rag?.status !== "completed") run = await persistAndIndexRun(run, repository);
        return json(await repository.retrieve(run.id, query, input.topK ?? 5));
      } catch (error) {
        const handled = handledInfrastructureError(error);
        if (handled) return handled;
        throw error;
      }
    }
    return json(lexicalRetrieve(run, query, input.topK ?? 5));
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && request.method === "GET") {
    let run;
    try {
      const repository = await repositoryForRequest(request, env, baseRepository);
      run = await repository.get(runMatch[1]);
    } catch (error) {
      const handled = handledInfrastructureError(error);
      if (handled) return handled;
      throw error;
    }
    if (run) return json(run);
    const message = baseRepository.persistence.mode === "ephemeral_memory"
      ? "Run does not exist or the ephemeral store was reset"
      : "Run does not exist";
    return apiError("run_not_found", message, 404);
  }

  return apiError("not_found", "API route not found", 404);
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) return response;
    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};

export { handleApi, RUN_SCHEMA_VERSION };

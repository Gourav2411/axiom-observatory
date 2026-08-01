const EMBEDDING_MODEL = "Supabase/gte-small";
const EMBEDDING_REVISION = "supabase-edge-runtime-managed";
const EMBEDDING_DIMENSIONS = 384;
const CHUNKING_STRATEGY = "word_window_v1";
const CHUNK_MAX_WORDS = 220;
const CHUNK_OVERLAP_WORDS = 32;
const CHUNK_MAX_CHARACTERS = 1_800;

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableUuid(...parts) {
  const digest = await sha256Hex(parts.map((part) => normalizedText(part)).join("\u001f"));
  const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const value = `${digest.slice(0, 12)}8${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function chunkText(value, {
  maxWords = CHUNK_MAX_WORDS,
  overlapWords = CHUNK_OVERLAP_WORDS,
  maxCharacters = CHUNK_MAX_CHARACTERS,
} = {}) {
  const text = normalizedText(value);
  if (!text) return [];
  const words = text.split(" ");
  if (words.length <= maxWords && text.length <= maxCharacters) {
    return [{ content: text, tokenCount: words.length }];
  }

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + maxWords);
    while (end > start + 1 && words.slice(start, end).join(" ").length > maxCharacters) end -= 1;
    let slice = words.slice(start, end);
    if (!slice.length) break;
    if (slice.length === 1 && slice[0].length > maxCharacters) {
      slice = [slice[0].slice(0, maxCharacters)];
    }
    chunks.push({ content: slice.join(" "), tokenCount: slice.length });
    if (end >= words.length) break;
    start = Math.max(start + 1, end - Math.min(overlapWords, end - start - 1));
  }
  return chunks;
}

function evidenceDocument(item, run) {
  const title = [
    item.datatypeId ? item.datatypeId.replaceAll("_", " ") : "Unclassified",
    "evidence",
    item.datasourceId ? `from ${item.datasourceId}` : null,
  ].filter(Boolean).join(" ");
  const citations = uniqueStrings([
    item.id,
    ...(item.literatureIds ?? []).map((id) => `PMID:${id}`),
    item.studyId ? `study:${item.studyId}` : null,
    item.variantId ? `variant:${item.variantId}` : null,
    item.drugId ? `drug:${item.drugId}` : null,
  ]);
  const content = [
    title,
    `Target ${run.target?.label ?? run.target?.id} (${run.target?.id})`,
    `Disease ${run.disease?.label ?? run.disease?.id} (${run.disease?.id})`,
    item.datatypeId ? `Evidence data type ${item.datatypeId}` : null,
    item.datasourceId ? `Evidence source ${item.datasourceId}` : null,
    item.studyId ? `Study ${item.studyId}` : null,
    item.variantId ? `Variant ${item.variantId}` : null,
    item.drugId ? `Drug ${item.drugId}` : null,
    item.literatureIds?.length ? `Linked literature ${item.literatureIds.map((id) => `PMID ${id}`).join(", ")}` : null,
  ].filter(Boolean).join(". ");
  return {
    documentKind: "open_targets_direct_evidence",
    externalId: item.id,
    title,
    content,
    sourceUrl: `https://platform.opentargets.org/evidence/${encodeURIComponent(item.targetId ?? run.target?.id)}/${encodeURIComponent(item.diseaseId ?? run.disease?.id)}`,
    license: "CC0-1.0",
    citations,
    provenance: {
      sourceId: "open-targets-pair-evidence",
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

function literatureDocument(item) {
  const title = normalizedText(item.title) || "Untitled literature record";
  const citations = uniqueStrings([
    item.id,
    item.pmid ? `PMID:${item.pmid}` : null,
    item.pmcid ? `PMCID:${item.pmcid}` : null,
    item.doi ? `DOI:${item.doi}` : null,
  ]);
  const content = [
    title,
    normalizedText(item.abstractText),
    item.authors ? `Authors ${item.authors}` : null,
    item.journal ? `Journal ${item.journal}` : null,
    item.publicationDate ? `Published ${item.publicationDate}` : null,
  ].filter(Boolean).join(". ");
  return {
    documentKind: "europe_pmc_literature",
    externalId: item.id,
    title,
    content,
    sourceUrl: item.sourceUrl ?? null,
    // Open-access status is not treated as an article-level reuse licence.
    license: item.license ?? null,
    citations,
    provenance: {
      sourceId: "europe-pmc-search",
      recordId: item.id,
      pmid: item.pmid ?? null,
      pmcid: item.pmcid ?? null,
      doi: item.doi ?? null,
      isOpenAccess: Boolean(item.isOpenAccess),
    },
  };
}

function sourceRetrievedAt(run, sourceId) {
  return run.provenance?.find((source) => source.sourceId === sourceId)?.retrievedAt
    ?? run.createdAt
    ?? new Date().toISOString();
}

async function buildNormalizedRunPayload(run) {
  const targetSourceId = await stableUuid(run.id, "source", "open-targets-association");
  const pairSourceId = await stableUuid(run.id, "source", "open-targets-pair-evidence");
  const literatureSourceId = await stableUuid(run.id, "source", "europe-pmc-search");
  const literatureQuery = run.literature?.query ?? "";
  const literatureQueryHash = await sha256Hex(literatureQuery);

  const sources = [
    {
      id: targetSourceId,
      provider: "open-targets-platform",
      sourceNativeId: `target-associations:${run.target?.id}`,
      endpoint: "https://api.platform.opentargets.org/api/v4/graphql",
      query: { operation: "TargetEvidence", targetId: run.target?.id, pageSize: 200, enableIndirect: false },
      license: "CC0-1.0 data / Apache-2.0 code",
      releaseVersion: null,
      retrievedAt: sourceRetrievedAt(run, "open-targets-platform"),
      checksumSha256: null,
      rawObjectPath: null,
      metadata: { sourceName: "Open Targets Platform", evidenceClass: "upstream_association" },
    },
    {
      id: pairSourceId,
      provider: "open-targets-platform",
      sourceNativeId: `pair-evidence:${run.target?.id}:${run.disease?.id}`,
      endpoint: "https://api.platform.opentargets.org/api/v4/graphql",
      query: { operation: "PairEvidence", targetId: run.target?.id, diseaseId: run.disease?.id, pageSize: 100, cursor: run.evidence?.cursor ?? null },
      license: "CC0-1.0 data / Apache-2.0 code",
      releaseVersion: null,
      retrievedAt: sourceRetrievedAt(run, "open-targets-platform"),
      checksumSha256: null,
      rawObjectPath: null,
      metadata: { sourceName: "Open Targets Platform", evidenceClass: "direct_evidence" },
    },
    {
      id: literatureSourceId,
      provider: "europe-pmc",
      sourceNativeId: `search:${literatureQueryHash}`,
      endpoint: "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
      query: { query: literatureQuery, resultType: "core", pageSize: 25, sort: "CITED desc" },
      license: "Europe PMC terms; article-level reuse varies",
      releaseVersion: null,
      retrievedAt: sourceRetrievedAt(run, "europe-pmc"),
      checksumSha256: null,
      rawObjectPath: null,
      metadata: { sourceName: "Europe PMC", hitCount: run.literature?.hitCount ?? 0 },
    },
  ];

  const evidenceRecords = [];
  const literatureRecords = [];
  const documents = [];
  const chunks = [];

  for (const item of run.evidence?.items ?? []) {
    const recordId = await stableUuid(run.id, "evidence", item.id);
    evidenceRecords.push({
      id: recordId,
      sourceId: pairSourceId,
      externalId: item.id,
      targetId: item.targetId ?? run.target?.id,
      diseaseId: item.diseaseId ?? run.disease?.id,
      datatypeId: item.datatypeId ?? null,
      datasourceId: item.datasourceId ?? null,
      upstreamScore: item.upstreamScore ?? null,
      scoreSemantics: "open_targets_evidence_rank_not_confidence",
      literatureIds: item.literatureIds ?? [],
      studyId: item.studyId ?? null,
      variantId: item.variantId ?? null,
      drugId: item.drugId ?? null,
      payload: item,
    });
    const normalized = evidenceDocument(item, run);
    const documentId = await stableUuid(run.id, "document", "evidence", item.id);
    const contentSha256 = await sha256Hex(normalized.content);
    documents.push({
      id: documentId,
      sourceId: pairSourceId,
      literatureRecordId: null,
      evidenceRecordId: recordId,
      documentKind: normalized.documentKind,
      externalId: normalized.externalId,
      title: normalized.title,
      content: normalized.content,
      sourceUrl: normalized.sourceUrl,
      license: normalized.license,
      contentSha256,
      metadata: {
        citations: normalized.citations,
        provenance: normalized.provenance,
        indexingPolicy: "normalized_open_targets_record",
      },
    });
    for (const [chunkIndex, chunk] of chunkText(normalized.content).entries()) {
      chunks.push({
        id: await stableUuid(run.id, "chunk", documentId, chunkIndex),
        documentId,
        chunkIndex,
        content: chunk.content,
        contentSha256: await sha256Hex(chunk.content),
        tokenCount: chunk.tokenCount,
      });
    }
  }

  for (const item of run.literature?.items ?? []) {
    const recordId = await stableUuid(run.id, "literature", item.id);
    literatureRecords.push({
      id: recordId,
      sourceId: literatureSourceId,
      externalId: item.id,
      pmid: item.pmid ?? null,
      pmcid: item.pmcid ?? null,
      doi: item.doi ?? null,
      title: item.title ?? "Untitled result",
      abstractText: item.abstractText ?? null,
      authors: item.authors ?? null,
      journal: item.journal ?? null,
      publicationDate: /^\d{4}-\d{2}-\d{2}$/.test(item.publicationDate ?? "") ? item.publicationDate : null,
      citedByCount: Number(item.citedByCount ?? 0),
      isOpenAccess: Boolean(item.isOpenAccess),
      sourceUrl: item.sourceUrl ?? null,
      license: item.license ?? null,
      payload: item,
    });
    const normalized = literatureDocument(item);
    const documentId = await stableUuid(run.id, "document", "literature", item.id);
    const contentSha256 = await sha256Hex(normalized.content);
    documents.push({
      id: documentId,
      sourceId: literatureSourceId,
      literatureRecordId: recordId,
      evidenceRecordId: null,
      documentKind: normalized.documentKind,
      externalId: normalized.externalId,
      title: normalized.title,
      content: normalized.content,
      sourceUrl: normalized.sourceUrl,
      license: normalized.license,
      contentSha256,
      metadata: {
        citations: normalized.citations,
        provenance: normalized.provenance,
        indexingPolicy: "europe_pmc_title_abstract_metadata",
      },
    });
    for (const [chunkIndex, chunk] of chunkText(normalized.content).entries()) {
      chunks.push({
        id: await stableUuid(run.id, "chunk", documentId, chunkIndex),
        documentId,
        chunkIndex,
        content: chunk.content,
        contentSha256: await sha256Hex(chunk.content),
        tokenCount: chunk.tokenCount,
      });
    }
  }

  const stages = await Promise.all((run.stages ?? []).map(async ({ id, status, ...config }) => ({
    id: await stableUuid(run.id, "stage", id),
    stageKey: id,
    status,
    config,
  })));
  const payload = {
    snapshot: run,
    run: {
      id: run.id,
      schemaVersion: run.schemaVersion,
      status: run.status,
      targetId: run.target?.id,
      targetLabel: run.target?.label ?? null,
      diseaseId: run.disease?.id,
      diseaseLabel: run.disease?.label ?? null,
      researchQuestion: null,
      input: { target: run.target, disease: run.disease },
      warnings: run.warnings ?? [],
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    association: run.association ? {
      sourceId: targetSourceId,
      targetId: run.association.targetId,
      diseaseId: run.association.diseaseId,
      upstreamScore: run.association.associationScore ?? null,
      datatypeScores: run.association.datatypeScores ?? [],
      datasourceScores: run.association.datasourceScores ?? [],
      directMatch: Boolean(run.association.directMatch),
      scoreSemantics: "open_targets_association_rank_not_confidence",
    } : null,
    stages,
    sources,
    evidenceRecords,
    literatureRecords,
    documents,
    chunks,
  };

  return {
    payload,
    counts: {
      sources: sources.length,
      evidenceRecords: evidenceRecords.length,
      literatureRecords: literatureRecords.length,
      documents: documents.length,
      chunks: chunks.length,
      embeddedChunks: 0,
    },
  };
}

export {
  CHUNKING_STRATEGY,
  CHUNK_MAX_CHARACTERS,
  CHUNK_MAX_WORDS,
  CHUNK_OVERLAP_WORDS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_REVISION,
  buildNormalizedRunPayload,
  chunkText,
  sha256Hex,
  stableUuid,
};

import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_MAX_CHARACTERS,
  CHUNK_MAX_WORDS,
  buildNormalizedRunPayload,
  chunkText,
} from "../worker/rag-pipeline.js";

test("chunking keeps gte-small inputs bounded with deterministic overlap", () => {
  const text = Array.from({ length: 520 }, (_, index) => `biomedical-${index}`).join(" ");
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.tokenCount <= CHUNK_MAX_WORDS);
    assert.ok(chunk.content.length <= CHUNK_MAX_CHARACTERS);
  }
  const firstWords = chunks[0].content.split(" ");
  const secondWords = chunks[1].content.split(" ");
  assert.ok(secondWords.includes(firstWords.at(-1)));
});

test("normalized payload preserves identifiers, provenance, citations and hashes", async () => {
  const run = {
    schemaVersion: "2.0.0",
    id: "11111111-1111-4111-8111-111111111111",
    status: "evidence_ready",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:01.000Z",
    target: { id: "ENSG00000154310", label: "TNIK", name: "TRAF2 and NCK interacting kinase" },
    disease: { id: "EFO_0000768", label: "idiopathic pulmonary fibrosis" },
    association: {
      targetId: "ENSG00000154310",
      diseaseId: "EFO_0000768",
      associationScore: 0.044,
      datatypeScores: [],
      datasourceScores: [],
      directMatch: true,
    },
    evidence: {
      cursor: null,
      items: [{
        id: "evidence-1",
        targetId: "ENSG00000154310",
        diseaseId: "EFO_0000768",
        datatypeId: "genetic_association",
        datasourceId: "ot_genetics_portal",
        upstreamScore: 0.8,
        literatureIds: ["123456"],
        studyId: "GCST0001",
      }],
    },
    literature: {
      query: "TNIK AND idiopathic pulmonary fibrosis",
      hitCount: 1,
      items: [{
        id: "PMID:123456",
        pmid: "123456",
        doi: "10.1000/demo",
        title: "TNIK inhibition in pulmonary fibrosis",
        abstractText: "A grounded abstract describing TNIK inhibition and pulmonary fibrosis.",
        authors: "A. Researcher",
        journal: "Evidence Journal",
        publicationDate: "2026-01-01",
        citedByCount: 4,
        isOpenAccess: true,
        sourceUrl: "https://europepmc.org/article/MED/123456",
      }],
    },
    stages: [{ id: "rag_index", status: "pending", label: "Hybrid RAG index" }],
    provenance: [
      { sourceId: "open-targets-platform", retrievedAt: "2026-08-01T00:00:00.000Z" },
      { sourceId: "europe-pmc", retrievedAt: "2026-08-01T00:00:00.000Z" },
    ],
    warnings: [],
  };

  const { payload, counts } = await buildNormalizedRunPayload(run);
  const retry = await buildNormalizedRunPayload(run);
  assert.deepEqual(counts, {
    sources: 3,
    evidenceRecords: 1,
    literatureRecords: 1,
    documents: 2,
    chunks: 2,
    embeddedChunks: 0,
  });
  assert.equal(payload.run.id, run.id);
  assert.match(payload.stages[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const collection of ["stages", "sources", "evidenceRecords", "literatureRecords", "documents", "chunks"]) {
    assert.deepEqual(
      retry.payload[collection].map((item) => item.id),
      payload[collection].map((item) => item.id),
      `${collection} identities must be stable across retries`,
    );
  }
  assert.equal(payload.association.scoreSemantics, "open_targets_association_rank_not_confidence");
  assert.equal(payload.evidenceRecords[0].externalId, "evidence-1");
  assert.equal(payload.evidenceRecords[0].scoreSemantics, "open_targets_evidence_rank_not_confidence");
  assert.equal(payload.literatureRecords[0].pmid, "123456");
  assert.equal(payload.literatureRecords[0].license, null);
  assert.ok(payload.documents.some((document) => document.metadata.citations.includes("PMID:123456")));
  for (const document of payload.documents) assert.match(document.contentSha256, /^[0-9a-f]{64}$/);
  for (const chunk of payload.chunks) assert.match(chunk.contentSha256, /^[0-9a-f]{64}$/);
});

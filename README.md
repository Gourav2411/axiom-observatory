# Axiom Observatory

Axiom Observatory is an open-source-first evidence workspace for therapeutic target research. The current development slice resolves a target and disease, retrieves live target–disease evidence from Open Targets, retrieves matching literature from Europe PMC, and preserves source-level provenance in an exportable run record.

It is an evidence retrieval system, not a clinical decision system. It does not claim that an association score is a probability, and it does not simulate docking, toxicity, efficacy, or a generated scientific answer.

## Current status

| Capability | State | What it means |
| --- | --- | --- |
| Target and disease resolution | Live | Open Targets GraphQL search with stable Ensembl/EFO/MONDO identifiers |
| Association and direct evidence | Live | Aggregate ranking signal plus direct evidence records from Open Targets |
| Literature retrieval | Live | Europe PMC metadata, abstracts when available, identifiers, and source links |
| Grounded retrieval | Live | Deterministic lexical retrieval over evidence and literature; no generated answer |
| Provenance and JSON export | Live | Exact endpoints, queries, retrieval times, identifiers, and reuse notes |
| Run persistence | Dual mode | Durable Supabase Postgres when configured; explicit in-memory fallback for local UI work |
| Database authorization | Implemented vertical | Supabase browser Auth, server-side session validation, default workspace provisioning, and RLS-scoped snapshots |
| Embedding/vector retrieval | Not configured | Planned sentence-transformers/BGE plus pgvector or Qdrant vertical |
| Agentic synthesis | Not configured | Must be citation-bound and evaluation-gated before it is enabled |
| Docking | Not configured | Planned isolated Smina or AutoDock Vina worker |
| ADMET/toxicity | Not configured | Planned ADMET-AI worker; prediction only, never experimental validation |
| Retrosynthesis | Not configured | Planned AiZynthFinder worker |

## Run locally

Use Node.js `20.19+` or `22.12+` (the repository includes `.nvmrc`).

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4174 --strictPort
```

Open `http://localhost:4174/`.

No API keys are required for the two connected public services. Sustained or production use still needs caching, throttling, retries, release pinning, and upstream-terms review.

### Run with Supabase

The repository includes the Supabase CLI, versioned migrations, RLS policies, Storage policies, and a durable run repository adapter. Local Supabase requires Docker Desktop or another Docker-compatible runtime.

```bash
npm run supabase:start
npm run supabase:reset
cp .env.example .env.local
npm run dev -- --host 0.0.0.0 --port 4174 --strictPort
```

Copy the local API URL, service-role key, and publishable/anon key reported by `npm run supabase:status` into `.env.local`. The service-role key is server-only and must never use a `VITE_` prefix. The publishable key is used by the browser Auth client and remains constrained by RLS. Without the two server variables the application deliberately uses its labeled in-memory repository and does not require sign-in.

## Verify

```bash
npm test
npm run build
npm run test:sites
```

Tests use mocked upstream transports, so they are deterministic and do not require network access. Browser verification should additionally exercise one real target–disease run.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Schema, persistence, and honest capability state |
| `GET` | `/api/targets/search?q=TNIK` | Resolve a target to an Ensembl identifier |
| `GET` | `/api/diseases/search?q=pulmonary%20fibrosis` | Resolve a disease/phenotype identifier |
| `POST` | `/api/runs` | Retrieve and normalize a live evidence run |
| `GET` | `/api/runs/:id` | Read an ephemeral run or an authenticated, workspace-authorized durable snapshot |
| `POST` | `/api/runs/:id/retrieval` | Rank grounded evidence passages for a research question without generating an answer |

Example run request:

```json
{
  "targetId": "ENSG00000154310",
  "targetLabel": "TNIK",
  "diseaseId": "EFO_0000768",
  "diseaseLabel": "idiopathic pulmonary fibrosis"
}
```

Example retrieval request:

```json
{
  "query": "What evidence connects TNIK inhibition with pulmonary fibrosis?",
  "topK": 8
}
```

The retrieval response contains passages, source identifiers, URLs, and a lexical ranking score. `generated` is always `false` in this slice.

In Supabase mode, all `/api/runs*` requests require the browser's Supabase bearer token. Target and disease search remain public because they proxy public identifier-resolution sources.

## Source semantics

- Open Targets documents its GraphQL API at <https://platform-docs.opentargets.org/data-access/graphql-api> and explains association scoring at <https://platform-docs.opentargets.org/associations>. Its association score is used only as an upstream ranking signal.
- Europe PMC documents its REST service at <https://europepmc.org/RestfulWebService>. Index presence and open-access status do not grant blanket reuse rights; article-level licensing varies.
- Source-native identifiers and links are retained. Normalized records never erase upstream provenance.

See [docs/architecture.md](docs/architecture.md) for the development architecture and the next production gates.
See [docs/supabase.md](docs/supabase.md) for local setup, remote deployment, security boundaries, and schema operations.

# Axiom Observatory

Axiom Observatory is an open-source-first evidence workspace for therapeutic target research. The current development milestone resolves a target and disease, retrieves live evidence from Open Targets and literature from Europe PMC, transactionally normalizes a durable run, builds a source-linked retrieval index, and exposes an inspectable agent workflow for grounded passage retrieval.

It is an evidence retrieval system, not a clinical decision system. It does not treat association or retrieval scores as probabilities, generate a scientific answer, or simulate docking, toxicity, efficacy, or experimental validation.

“Live in Supabase mode” below describes the implemented repository path; each new environment must apply the migrations, configure the private function gate, and deploy `axiom-embed` before enabling it.

## Current status

| Capability | State | What it means |
| --- | --- | --- |
| Target and disease resolution | Live | Open Targets GraphQL search with stable Ensembl/EFO/MONDO identifiers |
| Association and direct evidence | Live | Aggregate upstream ranking signal plus source-linked direct evidence records |
| Literature retrieval | Live | Europe PMC metadata and abstracts when available, identifiers, and source links |
| Transactional normalized ingestion | Live in Supabase mode | One authenticated Postgres RPC persists the compatibility snapshot, run, stages, association, sources, evidence, literature, documents, and chunks |
| Open-source embeddings | Live in Supabase mode | Supabase Edge Function using built-in `Supabase/gte-small`, 384 dimensions, normalized vectors, and the `supabase-edge-runtime-managed` revision contract |
| Hybrid retrieval | Live in Supabase mode | Run-scoped Postgres full-text search plus pgvector inner-product similarity, fused with reciprocal rank fusion (`hybrid_rrf_v2`) |
| Citation audit | Live | Each retrieval reports citation coverage; this checks citation presence, not truth or claim entailment |
| Agent workflow UI | Live | Planner → hybrid or lexical retriever → citation guard, with server-reported statuses, index metadata, score semantics, and source links |
| Retrieval-only boundary | Enforced | Retrieval responses report `generated: false`; no model-written scientific answer is returned |
| Run persistence | Dual mode | Durable, authenticated Supabase Postgres when configured; explicit process-memory mode otherwise |
| Lexical fallback | Live | Durable Postgres FTS when embeddings are unavailable; deterministic in-memory lexical ranking when Supabase is not configured |
| Database authorization | Implemented vertical | Supabase browser Auth, server-side session validation, default workspace provisioning, JWT-derived ownership, and RLS-scoped reads/writes |
| Docking | Not configured | No Smina or AutoDock Vina worker is installed |
| ADMET/toxicity | Not configured | No ADMET-AI worker is installed; any future output remains a prediction |
| Retrosynthesis | Not configured | No AiZynthFinder worker is installed |
| Agentic generation | Not configured | No synthesizer or scientific-answer model is enabled |

## Retrieval modes

The API always reports the mode actually used:

- `hybrid_rrf_v2` combines Postgres FTS and matching `gte-small` vectors with reciprocal rank fusion.
- `postgres_fts_v1` is the durable lexical fallback when a query embedding cannot be produced or matching indexed vectors are unavailable.
- `lexical_rank_v1` is the deterministic retrieval baseline used by the ephemeral in-memory repository.

Lexical rank, vector similarity, and fused rank are ranking signals, not confidence estimates. The UI labels them accordingly and keeps every result linked to its source record. A completed citation audit means returned results have source identifiers; it does not verify that the source is correct or that a proposed scientific claim follows from it.

## Run locally

Use Node.js `20.19+` or `22.12+` (the repository includes `.nvmrc`). The simplest local mode needs no API keys:

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4174 --strictPort
```

Open `http://localhost:4174/`. This mode is intentionally ephemeral and uses `lexical_rank_v1`; it does not claim to have a pgvector index.

The two connected upstream services are public. Sustained or production use still needs caching, throttling, retries, release pinning, monitoring, and review of upstream terms.

### Run the durable hybrid path with Supabase

The repository includes versioned migrations, RLS policies, the `axiom-embed` Edge Function, Storage policies, and a durable repository adapter. Local Supabase requires Docker Desktop or another Docker-compatible runtime.

Prepare the local database and environment:

```bash
npm run supabase:start
npm run supabase:reset
npm run supabase:status
cp .env.example .env.local
```

Copy the local API URL, service-role key, and publishable/anon key reported by `npm run supabase:status` into `.env.local`. The service-role key is server-only and must never use a `VITE_` prefix. The publishable key is used by the browser Auth client and remains constrained by RLS.

Serve the Edge Function in one terminal:

```bash
npx supabase functions serve
```

Keep JWT verification enabled; do not add `--no-verify-jwt`. The API forwards the signed-in user's bearer token and proves that the call came from the Axiom server with a server-only internal key. A browser bearer token alone cannot use the embedding endpoint.

Run the application in another terminal:

```bash
npm run dev -- --host 0.0.0.0 --port 4174 --strictPort
```

Durable `/api/runs*` routes require a Supabase session. Email/password sign-up requires email confirmation. Users can also request a passwordless magic link, request a password-reset email, and—after the provider is configured—sign in with Google. `VITE_SUPABASE_GOOGLE_ENABLED=false` keeps the Google button in its setup-required state by default; it is only a UI switch and does not configure the provider.

Magic-link and Google sign-in return through `/auth/callback`; password recovery returns through `/reset-password`. The browser uses PKCE so credentials return as a short-lived query code instead of URL-fragment tokens; the link must be completed in the same browser that requested it. The checked-in Supabase configuration allows only the exact production destinations at `https://axiom-observatory.minionarts.chatgpt.site` and their localhost development equivalents. Creating a run then performs authenticated normalized ingestion and bounded embedding batches before marking the RAG index complete. If the embedding worker is unavailable, normalized data remains durable and retrieval reports the Postgres FTS fallback rather than pretending hybrid ranking succeeded.

Stop the local stack with `npm run supabase:stop` after stopping the function server.

### Deploy Supabase migrations and the embedding function

Authenticate and link the CLI without committing secrets:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
npx supabase secrets set AXIOM_EMBED_INTERNAL_KEY=YOUR_SERVER_SERVICE_KEY
npx supabase functions deploy axiom-embed
```

Set `AXIOM_EMBED_INTERNAL_KEY` to the same server-only value used by the application for `SUPABASE_SERVICE_ROLE_KEY`; use a secure environment-file or secret manager so it does not enter shell history. Do not deploy the function with `--no-verify-jwt`. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as server-side hosting secrets, and build the browser with `VITE_SUPABASE_URL` plus the project's publishable key. Set `VITE_SUPABASE_GOOGLE_ENABLED=true` only after Google OAuth is enabled in Supabase.

For Google, create a Google Cloud OAuth client of type **Web application**, add the application origins, and register the Supabase callback URL shown on the Supabase Google provider page. Save the client ID and secret under Authentication → Sign In / Providers → Google; never put the secret in browser environment variables. Use a custom SMTP provider for production email confirmation, magic-link, and recovery delivery: the hosted default sender is restricted to project-team addresses, limited to two messages per hour, and has no delivery SLA. See [docs/supabase.md](docs/supabase.md) for the exact origins, callbacks, redirect allowlist, and complete security notes.

## Verify

```bash
npm test
npm run build
npm run test:sites
npm run supabase:lint
```

The automated suite covers the upstream API contract, ephemeral and durable repository behavior, normalized payloads and chunk bounds, the embedding client, the Edge Function's authenticated 384-dimensional contract, schema/RLS invariants, hybrid retrieval fixtures, and static hosting behavior. Mocked transports keep unit and API tests network-independent. `supabase:lint` requires the local Docker-backed stack.

After deploying to a disposable or development Supabase project, `npm run test:remote-rag` performs a real Open Targets + Europe PMC run, embeds its normalized chunks, executes hybrid retrieval, checks citation coverage and cross-user isolation, and removes the temporary users and workspaces it creates. It reads credentials from the ignored `.env.local`; do not run it against an environment where temporary account creation is prohibited.

Browser verification should additionally exercise one authenticated durable run and confirm:

1. the `rag_index` stage and Index tab report normalized counts, model, revision, dimensions, and chunking policy;
2. retrieval reports its actual hybrid or lexical mode;
3. planner, retriever, and citation-guard states are visible;
4. result scores are labeled as ranking/similarity, citations and source URLs are preserved, and `generated` remains `false`;
5. docking, ADMET/toxicity, retrosynthesis, and generation remain unavailable.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Schema, persistence, RAG model contract, and honest capability state |
| `GET` | `/api/targets/search?q=TNIK` | Resolve a target to an Ensembl identifier |
| `GET` | `/api/diseases/search?q=pulmonary%20fibrosis` | Resolve a disease/phenotype identifier |
| `POST` | `/api/runs` | Retrieve evidence, persist normalized records, and attempt RAG indexing |
| `GET` | `/api/runs/:id` | Read an ephemeral run or an authenticated, workspace-authorized durable snapshot |
| `POST` | `/api/runs/:id/retrieval` | Run grounded hybrid or lexical passage retrieval without generating an answer |

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

A run can include `rag.status`, the retrieval mode, embedding model/revision/dimensions, normalized record counts, chunking policy, and an explicit fallback reason. A retrieval can include the agent workflow, embedding provenance, citation audit, and per-result lexical, vector, and fused scores/ranks while retaining source citations and URLs. `generated` remains `false`.

In Supabase mode, all `/api/runs*` requests require the browser's Supabase bearer token. Target and disease search remain public because they proxy public identifier-resolution sources.

## Current limitations

- Only normalized Open Targets records and Europe PMC metadata/abstract text are indexed; licensed full-text ingestion is not implemented.
- `Supabase/gte-small` is an open embedding baseline, not a validated biomedical reasoning model. Its current revision label is managed by the Supabase Edge runtime rather than an immutable upstream model commit.
- Indexing is bounded: chunks are at most 220 words/1,800 characters, Edge Function inputs are 3–2,000 characters, embedding batches contain at most six items, and runs exceeding the 500-chunk safety cap are rejected by the indexer.
- Retrieval uses run-scoped FTS and semantic candidates with RRF; there is no cross-run corpus search, biomedical reranker, generated answer, or claim-entailment evaluator.
- Citation coverage validates identifier presence only. Source quality, causal interpretation, experimental reproducibility, and clinical relevance require separate review.
- Remote multi-user load, durable retry queues, rate limits, observability, retrieval quality, and model drift still need production validation; immediate embedding calls have only a bounded three-attempt transient retry policy.
- The health endpoint proves Postgres availability but does not execute an embedding probe; run/index and retrieval modes are authoritative for Edge Function availability.
- Docking, molecular preparation, ADMET/toxicity, retrosynthesis, wet-lab validation, and clinical translation are not implemented.

## Source semantics

- Open Targets documents its GraphQL API at <https://platform-docs.opentargets.org/data-access/graphql-api> and explains association scoring at <https://platform-docs.opentargets.org/associations>. Its scores are used only as upstream ranking signals.
- Europe PMC documents its REST service at <https://europepmc.org/RestfulWebService>. Index presence and open-access status do not grant blanket reuse rights; article-level licensing varies.
- Source-native identifiers, licences when known, content hashes, and links are retained. Normalized records never erase upstream provenance.

See [docs/architecture.md](docs/architecture.md) for the component flow and production gates.
See [docs/supabase.md](docs/supabase.md) for local setup, remote deployment, security boundaries, RPCs, and schema operations.

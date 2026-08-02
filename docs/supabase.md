# Supabase backend

Supabase is the durable identity, authorization, data, and retrieval plane for Axiom Observatory. It owns workspace membership, normalized evidence runs, source provenance, documents and chunks, embeddings, retrieval audit records, job state, and artifact metadata. The current Edge Function performs bounded text embedding only. Future docking, molecular preparation, ADMET/toxicity, and other CPU/GPU-heavy scientific computation still require isolated external workers.

## Runtime modes

The Evidence API selects one repository for each request environment:

| Configuration and runtime state | Repository and retrieval behavior |
| --- | --- |
| `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` present; database/function available; matching chunk vectors exist | Authenticated durable normalized ingestion plus `hybrid_rrf_v2` |
| Supabase configured; normalized database available; embedding function unavailable or vectors do not match | Durable normalized data plus reported `postgres_fts_v1` fallback |
| Neither server variable present | Ephemeral process-memory snapshot plus deterministic `lexical_rank_v1` |
| Only one server variable present | Configuration error; requests fail closed |
| Both variables present but Supabase persistence is unavailable | Persistence error; requests fail closed |

There is no silent memory fallback after Supabase is configured. The FTS fallback is different: it operates on the same authenticated, durable, normalized Postgres chunks and is returned with an explicit retrieval mode and warning.

## Local setup

Prerequisites:

- Node.js `20.19+` or `22.12+`;
- Docker Desktop or a Docker-compatible runtime;
- dependencies installed with `npm install`.

Start and reset the local stack:

```bash
npm run supabase:start
npm run supabase:reset
npm run supabase:status
```

Create `.env.local` from `.env.example` and copy the local values reported by `supabase status`:

```dotenv
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=your-local-service-role-key
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=your-local-anon-or-publishable-key
VITE_SUPABASE_GOOGLE_ENABLED=false
```

The same-origin Vite middleware receives the two unprefixed server variables. Only `VITE_SUPABASE_URL`, the publishable key, and the non-secret Google UI flag enter the browser bundle. The service-role key and OAuth client secret must never use a `VITE_` prefix. Production builds offer the verified Google provider by default; an explicit `VITE_SUPABASE_GOOGLE_ENABLED=false` hides the button in environments where it is unavailable. The flag only controls the UI and does not enable or secure the Supabase provider.

Serve all local Edge Functions in a dedicated terminal:

```bash
npx supabase functions serve
```

Do not use `--no-verify-jwt`. The `axiom-embed` request carries the signed-in user's bearer token and a server-only internal key matched against the function runtime's `SUPABASE_SERVICE_ROLE_KEY`. A browser session alone cannot call the embedding service. Start the application in another terminal:

```bash
npm run dev -- --host 0.0.0.0 --port 4174 --strictPort
```

Sign in through the browser before creating a durable run. The API validates the session before contacting upstream evidence providers, so an unauthenticated durable request cannot trigger upstream work or database mutation.

Local email/password registration requires confirmation. Open Mailpit at the URL reported by `supabase status` to follow confirmation, magic-link, and password-recovery emails. Magic-link and Google flows must redirect to `http://localhost:4174/auth/callback`; recovery must redirect to `http://localhost:4174/reset-password`. Keep the Google UI flag `false` unless the local Google provider has also been configured.

Stop the function server normally, then stop the local stack with:

```bash
npm run supabase:stop
```

## Remote deployment

Authenticate and link the CLI without committing secrets:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
npx supabase secrets set AXIOM_EMBED_INTERNAL_KEY=YOUR_SERVER_SERVICE_KEY
npx supabase functions deploy axiom-embed
npx supabase functions list
```

Set `AXIOM_EMBED_INTERNAL_KEY` to the same server-only value used by the application for `SUPABASE_SERVICE_ROLE_KEY`, preferably through a protected environment file so the value does not enter shell history. Keep function JWT verification enabled; do not deploy with `--no-verify-jwt`. The function uses the Supabase Edge runtime's built-in `gte-small` session and does not require a third-party model API key.

Configure the following values in the application hosting environment:

- server-only `SUPABASE_URL`;
- server-only `SUPABASE_SERVICE_ROLE_KEY`;
- build-time/browser `VITE_SUPABASE_URL`;
- build-time/browser `VITE_SUPABASE_PUBLISHABLE_KEY`;
- build-time/browser `VITE_SUPABASE_GOOGLE_ENABLED` (`true` only after provider setup).

The service-role key is used by the server as the Supabase API key. User-owned ingestion, reads, and retrieval forward the user's bearer token as `Authorization`, preserving `auth.uid()` and workspace authorization. The trusted vector-write RPC uses service-role authorization, and the embedding request also sends the key through a private internal header checked by the Edge Function. Never expose it to frontend code, logs, screenshots, client error messages, or `VITE_*` variables.

## Authentication flows and redirect configuration

The browser Auth surface supports four related flows:

- email/password registration and sign-in, with email confirmation required;
- passwordless email magic links via `signInWithOtp`, returning through `/auth/callback`;
- password recovery via `resetPasswordForEmail`, returning through `/reset-password`, followed by an authenticated `updateUser({ password })` submission;
- Google OAuth via `signInWithOAuth({ provider: "google" })`, returning through `/auth/callback`.

In Supabase Authentication → URL Configuration, set the Site URL to:

```text
https://axiom-observatory.minionarts.chatgpt.site
```

Allow these exact Redirect URLs:

```text
https://axiom-observatory.minionarts.chatgpt.site/auth/callback
https://axiom-observatory.minionarts.chatgpt.site/reset-password
http://localhost:4174/auth/callback
http://localhost:4174/reset-password
http://127.0.0.1:4174/auth/callback
http://127.0.0.1:4174/reset-password
```

The client also appends a validated `sb_flow_id` query parameter so concurrent
PKCE flows use the verifier created for that exact attempt. Keep the exact
entries above and add the same six entries with the narrowly scoped
`?sb_flow_id=*` suffix shown in `supabase/config.toml`; do not use a path-wide
production wildcard. If Supabase falls back to the Site URL, the application
also accepts a coded root callback and immediately cleans its one-time values.

The Site URL is the safe default used when a flow omits its redirect. Application calls should still pass the appropriate explicit URL. If custom email templates construct links from `{{ .SiteURL }}`, update them to honor `{{ .RedirectTo }}`; the stock `{{ .ConfirmationURL }}` already carries the allowed destination.

The browser client uses PKCE with an explicit one-time callback exchange. Supabase therefore returns a short-lived `?code=` that survives ordinary query-preserving redirects instead of putting access and refresh tokens in a URL fragment. The app waits for that exchange before removing callback parameters, keeps the browser on `/reset-password`, and records only a short-lived, user-matched recovery latch in `sessionStorage` so a reload does not collapse into the normal sign-in screen. PKCE still requires the callback to complete in the same browser and device that initiated signup, magic link, recovery, or OAuth. Supabase recommends that password-reset pages be publicly reachable; while the Sites deployment remains owner-only, the outer ChatGPT access gate is still an extra dependency and email callbacks are not production-reliable across devices or email-client browsers. The production topology should make the Site public—with Supabase still protecting the application and API—or move these callbacks to another public application host before general use.

### Google provider setup

1. In Google Auth Platform, configure the app audience and consent-screen branding. Keep scopes to `openid`, `userinfo.email`, and `userinfo.profile` unless the product genuinely needs additional Google data.
2. Create an OAuth Client ID with application type **Web application**.
3. Add these Authorized JavaScript origins (origins have no path):

   ```text
   https://axiom-observatory.minionarts.chatgpt.site
   http://localhost:4174
   ```

4. Add the Supabase Auth callback—not the application `/auth/callback`—as Google's Authorized redirect URI:

   ```text
   https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
   ```

   Copy the exact hosted callback from Authentication → Sign In / Providers → Google. For a local Supabase OAuth test, Google also needs `http://127.0.0.1:54321/auth/v1/callback`.
5. In Supabase Authentication → Sign In / Providers → Google, enable the provider and save the Google Client ID and Client Secret. Keep the secret in Supabase; never put it in source control or a `VITE_*` variable.
6. After the hosted provider and redirect list are saved, set `VITE_SUPABASE_GOOGLE_ENABLED=true` in the application build environment and redeploy the frontend.

The checked-in `[auth.external.google]` block remains disabled so local startup does not claim Google support without credentials. For intentional local OAuth testing, supply the web client ID, provide `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` outside source control, enable that block locally, and retain nonce checks.

### Email delivery and recovery security

Hosted email confirmation, magic-link, and password-reset flows need reliable transactional email. Supabase's default sender is restricted to addresses belonging to the project's organization team, allows only two messages per hour, and has no delivery SLA. It is suitable only for owner-team POC testing. Configure a custom SMTP provider under Authentication → Emails → SMTP Settings before testing other users or carrying production traffic. Send from a trusted application domain, configure SPF/DKIM/DMARC with the provider, and disable link tracking because rewritten single-use Auth links can fail. Enterprise email scanners can also consume a single-use link before the user; if this affects users, use an intermediate application page with a user-initiated confirmation button.

Use generic request-success messages so the UI does not disclose whether an email belongs to an account. Keep redirect destinations exact, enforce reasonable resend/OTP expiry limits, and enable CAPTCHA or Turnstile before exposing email-send forms publicly. The password-update form must only be shown for the authenticated recovery session created by the recovery link.

Before public access, verify the deployed Site URL and exact redirect list against `supabase/config.toml`, confirm email confirmation and custom SMTP delivery, enable CAPTCHA or Turnstile as a release requirement for every public email-send form, and test signup, magic-link, recovery, Google, sign-out, expiry, and refresh behavior end to end.

## Schema ownership

Versioned SQL lives in `supabase/migrations/`. The schema covers:

- workspaces, memberships, and projects;
- normalized runs, run associations, stages, sources, evidence, and literature;
- source-linked documents, deterministic chunks, content hashes, and 384-dimensional embeddings;
- persisted retrievals, per-result lexical/vector/fused scores, ranks, and citations;
- compatibility run snapshots used by the API read/export contract;
- append-only run events;
- durable scientific job and artifact metadata;
- private Storage buckets and workspace-scoped policies.

All exposed application tables use Row Level Security. Tenant-owned child records use composite run/workspace relationships so a child UUID cannot cross a workspace boundary. Direct anonymous access is revoked for the normalized application data and the hybrid pipeline RPCs.

In durable mode, the browser signs in with Supabase Auth and the API validates the bearer session. `ensure_default_workspace()` idempotently provisions the caller's workspace. Subsequent PostgREST and RPC requests use the service key as `apikey` and the user's access token as `Authorization`; RLS and security-definer functions derive ownership from the JWT, not from possession of a run UUID.

## Transactional normalized ingestion

`persist_evidence_run_v1(p_payload jsonb)` is the ingestion boundary. In one Postgres transaction it:

1. requires `auth.uid()` and resolves the caller's default workspace;
2. validates run identity, payload types, status enums, ownership, and child-array structure;
3. takes a run-scoped advisory transaction lock;
4. upserts the compatibility snapshot and normalized run;
5. writes the association, stages, sources, evidence records, literature records, documents, and chunks;
6. preserves existing embeddings only when a chunk's content hash is unchanged;
7. returns normalized counts and caller/workspace identity.

The payload builder retains source-native identifiers, source URLs, citations, licences when known, provenance metadata, and SHA-256 content hashes. Open Targets scores are stored with explicit “ranking, not confidence” semantics. Europe PMC open-access status is not treated as an article-level reuse licence.

This transaction makes normalized evidence durable before embedding begins. Derived child UUIDs are stable within a run, so the same payload can be retried without inventing duplicate records. Embedding is a subsequent bounded phase, so an inference failure can fall back to FTS without rolling back acquired source records. Immediate transient embedding calls receive a bounded three-attempt retry; durable queued recovery is not yet complete.

## Embedding function

`supabase/functions/axiom-embed/index.ts` implements a narrow authenticated batch contract:

| Constraint | Value |
| --- | --- |
| Model | `Supabase/gte-small` |
| Runtime revision contract | `supabase-edge-runtime-managed` |
| Dimensions | `384` |
| Pooling/normalization | Mean pool, normalized vector |
| Batch size | 1–6 unique IDs |
| Input size | 3–2,000 characters after trimming |
| Method | Authenticated `POST` only |

The `Supabase.ai.Session("gte-small")` is module-scoped so warm function instances can reuse it. The function requires both gateway bearer authentication and the Axiom server's internal key, then rejects malformed batches, duplicate IDs, invalid dimensions, non-finite values, and vectors outside its normalization tolerance. Responses are `no-store`. Runtime failures return bounded error messages and do not echo source text.

The server-side embedding client adds a 25-second per-attempt timeout, a maximum of three attempts for network, `429`, and selected `5xx` failures, and validates model, revision, dimensions, normalization metadata, IDs, vector length, finite values, and approximate magnitude. It forwards the user's bearer token for the function gateway and keeps the API/internal key server-side.

The application processes at most 500 selected chunk rows per run and intentionally rejects a result set that exceeds that safety cap. Application embedding batches contain at most six chunks. These are POC resource bounds, not throughput claims.

## Applying embeddings

`apply_chunk_embeddings_v1` accepts one trusted server batch and revalidates the boundary inside Postgres. Execute permission is revoked from `authenticated` and granted only to `service_role`. It verifies:

- the service-role caller and run-derived workspace;
- the exact `Supabase/gte-small` and `supabase-edge-runtime-managed` contract;
- unique UUID chunk identities belonging to the run;
- exactly 384 numeric, finite, nonzero values per vector with `|norm²−1| ≤ 0.002`;
- model/revision consistency across the completed run index.

The function takes the same run-scoped advisory lock as ingestion. It updates `rag_index` progress and will not mark the stage complete until every run chunk has a matching model/revision embedding. The schema requires vector, model, and revision provenance to be either all null or all present.

The hybrid migration intentionally clears any earlier experimental embeddings before changing vector dimensions to 384. Embeddings from different models or revisions must not be compared without an explicit re-indexing migration.

## Hybrid retrieval and lexical fallback

`execute_run_retrieval_v2` is the only application retrieval RPC. The earlier generic `hybrid_search_document_chunks` signature is retained as a service-role-only compatibility tombstone and must not be used by application clients.

For each authorized run query, `execute_run_retrieval_v2`:

1. validates query length, `topK`, RRF configuration, and the all-or-none query-embedding provenance tuple;
2. scopes eligible chunks to the caller-visible run;
3. computes Postgres English FTS candidates;
4. computes inner-product semantic candidates only when chunk model and revision exactly match the query embedding;
5. combines the ranks with reciprocal rank fusion (`rrf_k = 60`);
6. persists the retrieval and ranked result rows;
7. returns source URLs, identifiers, citations, provenance, score meanings, warnings, and citation coverage.

The database uses exact semantic ranking after the run filter at this milestone. A partial HNSW index with the inner-product operator class exists for future/vector-specific query plans, but the current small-run RPC is designed to avoid filtered approximate-nearest-neighbor under-return.

The response mode is authoritative:

- `hybrid_rrf_v2` means matching FTS and pgvector candidates were fused;
- `postgres_fts_v1` means the durable query used normalized FTS because query embedding failed or compatible vectors were unavailable;
- `lexical_rank_v1` never comes from this RPC; it is the separate process-memory baseline.

All score metadata states that lexical rank, vector similarity, and RRF are not probability or confidence. The citation audit measures whether returned records carry source identifiers. It does not validate source truth, claim entailment, causal mechanism, efficacy, toxicity, or clinical relevance. Retrieval responses remain `generated: false`.

## Agent workflow contract

The API and UI expose a concise workflow trace:

1. Query planner;
2. Hybrid retriever or an explicitly labeled lexical retriever;
3. Citation guard.

This is a deterministic registered-tool flow, not a free-form autonomous agent. The UI also exposes index counts, model/revision/dimensions, chunking policy, fallback reason, score breakdowns, citation coverage, and source links. Missing metadata is displayed as unavailable rather than inferred.

No synthesizer is configured. A completed citation guard does not create a scientific claim.

## Scientific jobs

Supabase Queues and the `jobs` table prepare durable dispatch and user-visible state, but queue consumers are not implemented in this milestone. Future scientific jobs will run in isolated external containers:

```text
API → Postgres transaction → queue message → external worker
    → private Storage artifacts → normalized prediction + provenance
```

Workers must be idempotent, lease jobs, heartbeat, checkpoint, record image/tool/model versions, and complete a queue message only after outputs are durably committed. The `axiom-embed` Edge Function is not a template for executing AutoDock Vina, RDKit, ADMET-AI, or GPU-heavy scientific workloads.

Docking, ADMET/toxicity, retrosynthesis, scientific-answer generation, wet-lab validation, and clinical validation remain not configured.

## Validation

Run the network-independent tests and production build:

```bash
npm test
npm run build
npm run test:sites
```

The suite covers:

- public upstream search/evidence normalization and score semantics;
- ephemeral lexical retrieval and `generated: false`;
- authenticated durable snapshots, transactional normalized ingestion, hybrid retrieval fixtures, RLS identity propagation, and fail-closed errors;
- deterministic chunk bounds, hashes, identifiers, citations, and provenance;
- embedding-client authentication, timeouts, dimension/revision drift, and vector validation;
- the Edge Function's authenticated, bounded, normalized 384-dimensional source contract;
- schema, RLS, composite tenancy, vector/RPC, and static hosting invariants.

With the local Docker-backed stack running, also execute:

```bash
npm run supabase:lint
```

Static and mocked tests do not replace a remote integration pass. Before production, test concurrent users in different workspaces, migration replay, Edge deployment, Auth expiry/refresh, embedding failure and recovery, FTS fallback, model drift, citation coverage, load bounds, and backup/restore.

## Scientific and operational limitations

- Only normalized evidence records and Europe PMC metadata/abstracts are indexed; licensed full-text ingestion is not implemented.
- `gte-small` is a retrieval baseline, not a biomedical reasoning, safety, toxicity, or efficacy model.
- The Supabase-managed revision label is not an immutable upstream model commit.
- Citation presence does not establish claim support or scientific validity.
- Cross-run retrieval, reranking, generation, claim entailment, and human-review workflows are absent.
- Retry queues, rate limits, production observability, capacity tests, drift monitoring, and disaster recovery are incomplete.
- Health checks probe durable Postgres but do not execute the Edge model; run/index and retrieval responses provide the authoritative embedding capability state.
- Docking, molecular preparation, ADMET/toxicity, retrosynthesis, wet-lab validation, and clinical translation are unavailable.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260801173000_initial_axiom_backend.sql", import.meta.url);
const ragMigrationUrl = new URL("../supabase/migrations/20260801203000_hybrid_rag_pipeline.sql", import.meta.url);
const configUrl = new URL("../supabase/config.toml", import.meta.url);
const envExampleUrl = new URL("../.env.example", import.meta.url);
const supabaseClientUrl = new URL("../src/supabase.js", import.meta.url);

test("Supabase migration contains the durable run snapshot contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const required of [
    "create table public.run_snapshots",
    "schema_version text not null",
    "target_id text",
    "disease_id text",
    "snapshot jsonb not null",
    "run_snapshots_select_member",
    "run_snapshots_insert_writer",
    "ensure_default_workspace",
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("Supabase schema enables workspace RLS on every exposed application table", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const tables = [
    "workspaces", "workspace_members", "projects", "runs", "run_snapshots",
    "run_stages", "sources", "evidence_records", "literature_records", "documents",
    "document_chunks", "retrievals", "retrieval_results", "jobs", "artifacts", "run_events",
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /create or replace function public\.is_workspace_member/i);
  assert.match(sql, /revoke all on public\.workspaces[\s\S]+public\.run_events from anon/i);
  assert.match(sql, /revoke all on function public\.is_workspace_member\(uuid\) from public, anon/i);
  assert.match(sql, /grant insert \(workspace_id, user_id, role, invited_by\), update \(role\), delete[\s\S]+workspace_members to authenticated/i);
  assert.match(sql, /role <> 'owner'[\s\S]+has_workspace_role\(workspace_id, array\['owner'\]/i);
});

test("tenant-owned records use composite foreign keys to prevent cross-workspace references", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const reference of [
    "foreign key (project_id, workspace_id) references public.projects(id, workspace_id)",
    "foreign key (run_id, workspace_id) references public.runs(id, workspace_id)",
    "foreign key (source_id, run_id, workspace_id) references public.sources(id, run_id, workspace_id)",
    "foreign key (document_id, run_id, workspace_id) references public.documents(id, run_id, workspace_id)",
    "foreign key (retrieval_id, run_id, workspace_id) references public.retrievals(id, run_id, workspace_id)",
    "foreign key (job_id, run_id, workspace_id) references public.jobs(id, run_id, workspace_id)",
  ]) assert.match(sql, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("Supabase schema prepares hybrid retrieval, queues, and private artifacts", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create extension if not exists vector/i);
  assert.match(sql, /embedding extensions\.vector\(768\)/i);
  assert.match(sql, /using hnsw/i);
  assert.match(sql, /hybrid_search_document_chunks/i);
  assert.match(sql, /operator\(extensions\.<=>\)/i);
  assert.match(sql, /perform pgmq\.create\('scientific_compute'\)/i);
  assert.match(sql, /'run-artifacts', 'run-artifacts', false/i);
  assert.match(sql, /create policy axiom_storage_select_member/i);
});

test("hybrid RAG migration fixes the embedding model contract and tenant boundaries", async () => {
  const sql = await readFile(ragMigrationUrl, "utf8");
  assert.ok((sql.match(/extensions\.vector\(384\)/gi) ?? []).length >= 5);
  assert.match(sql, /update public\.document_chunks[\s\S]+embedding = null[\s\S]+embedding_revision = null/i);
  assert.match(sql, /update public\.retrievals[\s\S]+query_embedding = null[\s\S]+embedding_revision = null/i);
  assert.match(sql, /using hnsw \(embedding extensions\.vector_ip_ops\)/i);
  assert.match(sql, /document_chunks_embedding_provenance_check[\s\S]+embedding_model[\s\S]+embedding_revision/i);
  assert.match(sql, /retrievals_embedding_provenance_check[\s\S]+embedding_model[\s\S]+embedding_revision/i);
  assert.match(sql, /unique index[^\n]+document_chunks_document_index_uidx[\s\S]+\(document_id, chunk_index\)/i);

  assert.match(sql, /create table public\.run_associations/i);
  assert.match(sql, /foreign key \(run_id, workspace_id\)[\s\S]+references public\.runs\(id, workspace_id\)/i);
  assert.match(sql, /alter table public\.run_associations enable row level security/i);
  assert.match(sql, /create policy run_associations_select_member/i);
  assert.match(sql, /grant select on public\.run_associations to authenticated/i);
});

test("hybrid RAG RPCs derive ownership and persist auditable retrievals", async () => {
  const sql = await readFile(ragMigrationUrl, "utf8");
  for (const rpc of [
    "persist_evidence_run_v1",
    "apply_chunk_embeddings_v1",
    "execute_run_retrieval_v2",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`, "i"));
    assert.match(sql, new RegExp(`${rpc}[\\s\\S]+security definer`, "i"));
  }

  assert.match(sql, /v_caller_id uuid := auth\.uid\(\)/i);
  assert.match(sql, /v_workspace_id := public\.ensure_default_workspace\(\)/i);
  assert.match(sql, /Run identifier is owned by another principal/i);
  assert.match(sql, /evidenceRecords[\s\S]+literatureRecords/i);
  assert.match(sql, /At most 100 embeddings may be applied per call/i);
  assert.match(sql, /Only the trusted embedding worker may write vectors/i);
  assert.match(sql, /v_model <> 'Supabase\/gte-small'/i);
  assert.match(sql, /v_revision <> 'supabase-edge-runtime-managed'/i);
  assert.match(sql, /jsonb_array_length\(v_item -> 'embedding'\) <> 384/i);
  assert.match(sql, /abs\(v_norm_squared - 1\.0\) > 0\.002/i);
  assert.match(sql, /embedding_model = v_model[\s\S]+embedding_revision = v_revision/i);
  assert.match(sql, /v_null_count <> 0[\s\S]+v_matching_count <> v_total_count/i);
  assert.match(sql, /revoke all on function public\.apply_chunk_embeddings_v1[\s\S]+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.apply_chunk_embeddings_v1[\s\S]+to service_role/i);

  assert.match(sql, /p_top_k integer default 8/i);
  assert.match(sql, /with eligible as materialized/i);
  assert.match(sql, /where dc\.run_id = p_run_id[\s\S]+dc\.workspace_id = v_workspace_id/i);
  assert.match(sql, /e\.embedding_model = v_embedding_model[\s\S]+e\.embedding_revision = v_embedding_revision/i);
  assert.match(sql, /insert into public\.retrievals/i);
  assert.match(sql, /insert into public\.retrieval_results/i);
  assert.match(sql, /'generated', false[\s\S]+'citationAudit'/i);
  assert.match(sql, /revoke all on function public\.execute_run_retrieval_v2[\s\S]+from public, anon/i);
  assert.match(sql, /grant execute on function public\.execute_run_retrieval_v2[\s\S]+to authenticated, service_role/i);
});

test("Supabase Auth config pins local callback destinations", async () => {
  const config = await readFile(configUrl, "utf8");
  assert.match(config, /project_id = "axiom-observatory"/);
  assert.match(config, /site_url = "http:\/\/localhost:4174"/);
  for (const redirect of [
    "http://localhost:4174/auth/callback",
    "http://localhost:4174/reset-password",
    "http://127.0.0.1:4174/auth/callback",
    "http://127.0.0.1:4174/reset-password",
  ]) assert.ok(config.includes(`"${redirect}"`), `missing exact Auth redirect: ${redirect}`);
  assert.doesNotMatch(config, /sb_flow_id=\*/);
  assert.match(config, /\[auth\.email\][\s\S]*?enable_confirmations = true/);
  assert.match(config, /\[auth\.external\.google\][\s\S]*?enabled = false[\s\S]*?client_id = ""[\s\S]*?secret = "env\(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET\)"/);
  assert.match(config, /file_size_limit = "50MiB"/);
  assert.match(config, /\[storage\.vector\]\s+enabled = false/);
});

test("Supabase provisions and backfills a personal workspace for every auth user", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260803011500_provision_personal_workspaces.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.provision_personal_workspace_for_user/i);
  assert.match(sql, /after insert on auth\.users/i);
  assert.match(sql, /for existing_user in select id from auth\.users/i);
  assert.match(sql, /on conflict \(workspace_id, user_id\) do update/i);
  assert.match(sql, /revoke all on function public\.provision_personal_workspace_for_user\(uuid\) from public, anon, authenticated/i);
});

test("Supabase accepts the local validation stage status emitted by the frontend", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260803012500_add_available_local_stage_status.sql", import.meta.url), "utf8");
  assert.match(sql, /alter type public\.stage_status add value if not exists 'available_local'/i);
});

test("campaign schema provides a tenant-safe durable chemistry queue and human review", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260803014500_campaign_system.sql", import.meta.url), "utf8");
  for (const table of ["campaigns", "campaign_candidates", "candidate_evaluations", "scientific_reviews"]) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  for (const rpc of ["create_campaign_v1", "add_campaign_candidate_v1", "queue_candidate_workflow_v1", "submit_scientific_review_v1", "lease_campaign_jobs_v1", "complete_campaign_job_v1"]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${rpc}`, "i"));
  }
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/i);
  assert.match(sql, /return query[\s\S]+insert into public\.jobs/i);
  assert.match(sql, /'docking_score'[\s\S]+'route_planning'/i);
  assert.match(sql, /evidence_snapshot/i);
});

test("campaign worker controls and assay ingestion fail closed with tenant boundaries", async () => {
  const controls = await readFile(new URL("../supabase/migrations/20260803110000_campaign_worker_controls.sql", import.meta.url), "utf8");
  assert.match(controls, /alter type public\.job_status add value if not exists 'blocked'/i);
  assert.match(controls, /create or replace function public\.heartbeat_campaign_job_v1/i);
  assert.match(controls, /attempts >= max_attempts/i);
  assert.match(controls, /auth\.role\(\) <> 'service_role'/i);

  const scopedLeasing = await readFile(new URL("../supabase/migrations/20260804090000_scoped_campaign_leasing.sql", import.meta.url), "utf8");
  assert.match(scopedLeasing, /create or replace function public\.lease_campaign_jobs_v2/i);
  assert.match(scopedLeasing, /p_job_types text\[\]/i);
  assert.match(scopedLeasing, /j\.job_type = any\(p_job_types\)/i);
  assert.match(scopedLeasing, /for update skip locked/i);
  assert.match(scopedLeasing, /grant execute[\s\S]*to service_role/i);

  const assays = await readFile(new URL("../supabase/migrations/20260803112000_assay_results.sql", import.meta.url), "utf8");
  assert.match(assays, /create table public\.assay_results/i);
  assert.match(assays, /foreign key \(candidate_id, run_id, workspace_id\)/i);
  assert.match(assays, /alter table public\.assay_results enable row level security/i);
  assert.match(assays, /provenance sourceReference is required/i);
  assert.match(assays, /grant execute on function public\.ingest_assay_result_v1\(uuid,jsonb\) to authenticated/i);
});

test("validation workbench can queue an authenticated ADMET-only job", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260804113000_validation_admet_queue.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.queue_validation_admet_v1/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /public\.can_write_workspace\(r\.workspace_id\)/i);
  assert.match(sql, /'validation-admet:' \|\| v_candidate\.id::text/i);
  assert.match(sql, /'admet'/i);
  assert.match(sql, /attempts = case[\s\S]*else 0/i);
  assert.match(sql, /grant execute[\s\S]*to authenticated/i);
});

test("prepared docking receptors receive a tenant-scoped durable upload grant", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260804114500_durable_receptor_input.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.prepare_receptor_upload_v1/i);
  assert.match(sql, /public\.can_write_workspace\(r\.workspace_id\)/i);
  assert.match(sql, /workspaceId/i);
  assert.match(sql, /grant execute[\s\S]*to authenticated/i);
});

test("clinical translation evidence is durable, tenant-scoped, and review-gated", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260803140000_clinical_translation_inputs.sql", import.meta.url), "utf8");
  assert.match(sql, /create table public\.clinical_translation_inputs/i);
  assert.match(sql, /foreign key \(candidate_id, run_id, workspace_id\)/i);
  assert.match(sql, /alter table public\.clinical_translation_inputs enable row level security/i);
  assert.match(sql, /review_status in \('pending', 'qualified', 'rejected'\)/i);
  assert.match(sql, /create or replace function public\.register_clinical_translation_input_v1/i);
  assert.match(sql, /create or replace function public\.review_clinical_translation_input_v1/i);
  assert.match(sql, /public\.can_write_workspace/i);
});

test("clinical model runs are tenant-scoped, asynchronously queued, and evidence-gated", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260804130000_clinical_simulation_runs.sql", import.meta.url), "utf8");
  assert.match(sql, /create table public\.clinical_simulation_runs/i);
  assert.match(sql, /foreign key \(candidate_id, run_id, workspace_id\)/i);
  assert.match(sql, /alter table public\.clinical_simulation_runs enable row level security/i);
  assert.match(sql, /queue_clinical_simulation_v1/i);
  assert.match(sql, /complete_clinical_simulation_v1/i);
  assert.match(sql, /research_scenario/);
  assert.match(sql, /evidence_qualified/i);
  assert.match(sql, /clinical_phase1_simulation/);
  assert.match(sql, /clinical_phase2_simulation/);
  assert.match(sql, /auth\.role\(\) <> 'service_role'/i);
});

test("browser environment example keeps Google sign-in disabled by default", async () => {
  const envExample = await readFile(envExampleUrl, "utf8");
  assert.match(envExample, /^VITE_SUPABASE_GOOGLE_ENABLED=false$/m);
  assert.doesNotMatch(envExample, /^VITE_.*(?:SERVICE_ROLE|CLIENT_SECRET)/m);
});

test("production browser builds enable the verified Google provider unless explicitly disabled", async () => {
  const source = await readFile(supabaseClientUrl, "utf8");
  assert.match(source, /googleUiFlag \? googleUiFlag === "true" : import\.meta\.env\.PROD/);
  assert.match(source, /supabaseGoogleConfigured = supabaseBrowserConfigured/);
  assert.doesNotMatch(source, /appendPkceFlowIdToRedirects/);
  assert.doesNotMatch(source, /CLIENT_SECRET|SERVICE_ROLE/);
});

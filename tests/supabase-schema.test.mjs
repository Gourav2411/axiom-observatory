import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260801173000_initial_axiom_backend.sql", import.meta.url);
const configUrl = new URL("../supabase/config.toml", import.meta.url);

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
  assert.match(sql, /perform pgmq\.create\('scientific_compute'\)/i);
  assert.match(sql, /'run-artifacts', 'run-artifacts', false/i);
  assert.match(sql, /create policy axiom_storage_select_member/i);
});

test("local Supabase config targets the application origin", async () => {
  const config = await readFile(configUrl, "utf8");
  assert.match(config, /project_id = "axiom-observatory"/);
  assert.match(config, /site_url = "http:\/\/localhost:4174"/);
  assert.match(config, /file_size_limit = "500MiB"/);
  assert.match(config, /\[storage\.vector\]\s+enabled = false/);
  assert.match(config, /enabled = true/);
});

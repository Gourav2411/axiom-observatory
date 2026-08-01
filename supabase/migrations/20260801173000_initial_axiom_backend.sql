begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
do $$
declare
  installed_schema text;
begin
  select n.nspname into installed_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if installed_schema is distinct from 'extensions' then
    execute 'alter extension vector set schema extensions';
  end if;
end;
$$;

do $$
begin
  execute 'create extension if not exists pgmq';
exception
  when undefined_file or insufficient_privilege then
    raise notice 'pgmq is unavailable; durable jobs remain usable but queue dispatch is disabled';
end;
$$;

create type public.workspace_role as enum ('owner', 'admin', 'researcher', 'viewer');
create type public.run_status as enum ('queued', 'running', 'evidence_ready', 'partial', 'failed', 'cancelled');
create type public.stage_status as enum ('pending', 'queued', 'running', 'completed', 'failed', 'not_configured', 'cancelled');
create type public.job_status as enum ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (
    slug !~ '^personal-'
    or slug = 'personal-' || replace(created_by::text, '-', '')
  )
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'researcher',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (workspace_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  description text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, workspace_id),
  unique (workspace_id, name)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  schema_version text not null,
  status public.run_status not null default 'queued',
  target_id text not null check (char_length(target_id) between 3 and 80),
  target_label text,
  disease_id text not null check (char_length(disease_id) between 3 and 80),
  disease_label text,
  research_question text,
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  idempotency_key text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, workspace_id),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete restrict
);

create unique index runs_workspace_idempotency_key_idx
  on public.runs (workspace_id, idempotency_key)
  where idempotency_key is not null;
create index runs_workspace_created_at_idx on public.runs (workspace_id, created_at desc);
create index runs_target_disease_idx on public.runs (workspace_id, target_id, disease_id);

-- Compatibility table for the current Worker repository. Rows without a
-- workspace are service-only and are never exposed through an authenticated RLS policy.
create table public.run_snapshots (
  id uuid primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  schema_version text not null,
  status text not null,
  target_id text,
  disease_id text,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index run_snapshots_workspace_created_at_idx
  on public.run_snapshots (workspace_id, created_at desc);

create table public.run_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  stage_key text not null check (char_length(stage_key) between 1 and 80),
  status public.stage_status not null default 'pending',
  attempt integer not null default 1 check (attempt > 0),
  progress double precision not null default 0 check (progress between 0 and 1),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  unique (run_id, stage_key, attempt)
);

create index run_stages_run_status_idx on public.run_stages (run_id, status);
create index run_stages_workspace_run_idx on public.run_stages (workspace_id, run_id);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  provider text not null check (char_length(provider) between 1 and 100),
  source_native_id text,
  endpoint text not null,
  query jsonb not null default '{}'::jsonb check (jsonb_typeof(query) in ('object', 'string')),
  license text,
  release_version text,
  retrieved_at timestamptz not null,
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  raw_object_path text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade
);

create unique index sources_run_native_record_idx
  on public.sources (run_id, provider, source_native_id)
  where source_native_id is not null;
create index sources_run_provider_idx on public.sources (run_id, provider);
create index sources_workspace_run_idx on public.sources (workspace_id, run_id);

create table public.evidence_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  source_id uuid,
  external_id text not null,
  target_id text not null,
  disease_id text not null,
  datatype_id text,
  datasource_id text,
  upstream_score double precision,
  literature_ids text[] not null default '{}',
  study_id text,
  variant_id text,
  drug_id text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (source_id, run_id, workspace_id) references public.sources(id, run_id, workspace_id) on delete set null (source_id),
  unique (run_id, external_id)
);

create index evidence_records_run_datasource_idx on public.evidence_records (run_id, datasource_id);
create index evidence_records_target_disease_idx on public.evidence_records (target_id, disease_id);
create index evidence_records_workspace_run_idx on public.evidence_records (workspace_id, run_id);

create table public.literature_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  source_id uuid,
  external_id text not null,
  pmid text,
  pmcid text,
  doi text,
  title text not null,
  abstract_text text,
  authors text,
  journal text,
  publication_date date,
  cited_by_count integer not null default 0 check (cited_by_count >= 0),
  is_open_access boolean not null default false,
  source_url text,
  license text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (source_id, run_id, workspace_id) references public.sources(id, run_id, workspace_id) on delete set null (source_id),
  unique (run_id, external_id)
);

create index literature_records_run_date_idx on public.literature_records (run_id, publication_date desc);
create index literature_records_pmid_idx on public.literature_records (pmid) where pmid is not null;
create index literature_records_doi_idx on public.literature_records (doi) where doi is not null;
create index literature_records_workspace_run_idx on public.literature_records (workspace_id, run_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  source_id uuid,
  literature_record_id uuid,
  evidence_record_id uuid,
  document_kind text not null,
  external_id text not null,
  title text,
  content text not null,
  source_url text,
  license text,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (source_id, run_id, workspace_id) references public.sources(id, run_id, workspace_id) on delete set null (source_id),
  foreign key (literature_record_id, run_id, workspace_id) references public.literature_records(id, run_id, workspace_id) on delete cascade,
  foreign key (evidence_record_id, run_id, workspace_id) references public.evidence_records(id, run_id, workspace_id) on delete cascade,
  check (num_nonnulls(literature_record_id, evidence_record_id) = 1),
  unique (run_id, document_kind, external_id, content_sha256)
);

create index documents_run_kind_idx on public.documents (run_id, document_kind);
create index documents_workspace_run_idx on public.documents (workspace_id, run_id);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  token_count integer check (token_count is null or token_count > 0),
  fts tsvector generated always as (to_tsvector('english'::regconfig, content)) stored,
  embedding extensions.vector(768),
  embedding_model text,
  embedding_revision text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (document_id, run_id, workspace_id) references public.documents(id, run_id, workspace_id) on delete cascade,
  check ((embedding is null and embedding_model is null) or (embedding is not null and embedding_model is not null)),
  unique (document_id, chunk_index, content_sha256)
);

create index document_chunks_run_idx on public.document_chunks (run_id, chunk_index);
create index document_chunks_workspace_run_idx on public.document_chunks (workspace_id, run_id);
create index document_chunks_fts_idx on public.document_chunks using gin (fts);
create index document_chunks_embedding_hnsw_idx
  on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create table public.retrievals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  query text not null check (char_length(query) between 3 and 500),
  retrieval_mode text not null,
  generated boolean not null default false check (generated = false),
  top_k integer not null check (top_k between 1 and 100),
  embedding_model text,
  query_embedding extensions.vector(768),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade
);

create index retrievals_run_created_at_idx on public.retrievals (run_id, created_at desc);
create index retrievals_workspace_run_idx on public.retrievals (workspace_id, run_id);

create table public.retrieval_results (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  retrieval_id uuid not null,
  chunk_id uuid not null,
  rank integer not null check (rank > 0),
  lexical_score double precision,
  vector_score double precision,
  fused_score double precision not null,
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (retrieval_id, run_id, workspace_id) references public.retrievals(id, run_id, workspace_id) on delete cascade,
  foreign key (chunk_id, run_id, workspace_id) references public.document_chunks(id, run_id, workspace_id) on delete cascade,
  primary key (retrieval_id, chunk_id),
  unique (retrieval_id, rank)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  stage_id uuid,
  job_type text not null check (char_length(job_type) between 1 and 80),
  status public.job_status not null default 'queued',
  priority integer not null default 0,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  result jsonb,
  error jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (stage_id, run_id, workspace_id) references public.run_stages(id, run_id, workspace_id) on delete set null (stage_id),
  unique (workspace_id, idempotency_key)
);

create index jobs_status_priority_idx on public.jobs (status, priority desc, created_at);
create index jobs_run_idx on public.jobs (run_id, created_at desc);
create index jobs_workspace_run_idx on public.jobs (workspace_id, run_id);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  stage_id uuid,
  job_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  bucket_id text not null,
  object_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  foreign key (stage_id, run_id, workspace_id) references public.run_stages(id, run_id, workspace_id) on delete set null (stage_id),
  foreign key (job_id, run_id, workspace_id) references public.jobs(id, run_id, workspace_id) on delete set null (job_id),
  unique (bucket_id, object_path)
);

create index artifacts_run_stage_idx on public.artifacts (run_id, stage_id);
create index artifacts_workspace_run_idx on public.artifacts (workspace_id, run_id);

create table public.run_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null,
  actor_type text not null check (actor_type in ('user', 'service', 'worker', 'system')),
  actor_id text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade,
  unique (run_id, sequence)
);

create index run_events_run_created_at_idx on public.run_events (run_id, created_at);
create index run_events_workspace_run_idx on public.run_events (workspace_id, run_id);

create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.set_updated_at();
create trigger runs_set_updated_at before update on public.runs
  for each row execute function public.set_updated_at();
create trigger run_snapshots_set_updated_at before update on public.run_snapshots
  for each row execute function public.set_updated_at();
create trigger run_stages_set_updated_at before update on public.run_stages
  for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.role()) = 'service_role', false)
    or exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = target_workspace_id
        and wm.user_id = (select auth.uid())
    );
$$;

create or replace function public.has_workspace_role(
  target_workspace_id uuid,
  allowed_roles public.workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.role()) = 'service_role', false)
    or exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = target_workspace_id
        and wm.user_id = (select auth.uid())
        and wm.role = any(allowed_roles)
    );
$$;

create or replace function public.can_write_workspace(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_workspace_role(
    target_workspace_id,
    array['owner', 'admin', 'researcher']::public.workspace_role[]
  );
$$;

create or replace function public.create_workspace(workspace_name text, workspace_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Authentication is required';
  end if;
  if workspace_slug like 'personal-%' then
    raise exception 'The personal- slug prefix is reserved';
  end if;

  insert into public.workspaces (name, slug, created_by)
  values (workspace_name, workspace_slug, caller_id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (new_workspace_id, caller_id, 'owner', caller_id);

  return new_workspace_id;
end;
$$;

create or replace function public.ensure_default_workspace()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  personal_slug text;
  resolved_workspace_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication is required';
  end if;

  personal_slug := 'personal-' || replace(caller_id::text, '-', '');

  select w.id into resolved_workspace_id
  from public.workspaces w
  where w.slug = personal_slug and w.created_by = caller_id;

  if resolved_workspace_id is null then
    insert into public.workspaces (name, slug, created_by)
    values ('Personal workspace', personal_slug, caller_id)
    on conflict (slug) do nothing
    returning id into resolved_workspace_id;

    if resolved_workspace_id is null then
      select w.id into resolved_workspace_id
      from public.workspaces w
      where w.slug = personal_slug and w.created_by = caller_id;
    end if;
  end if;

  if resolved_workspace_id is null then
    raise exception 'The reserved personal workspace slug is unavailable';
  end if;

  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = resolved_workspace_id and wm.user_id = caller_id
  ) then
    insert into public.workspace_members (workspace_id, user_id, role, invited_by)
    values (resolved_workspace_id, caller_id, 'owner', caller_id);
  end if;

  return resolved_workspace_id;
end;
$$;

create or replace function public.preserve_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_workspace_id uuid := old.workspace_id;
begin
  if exists (select 1 from public.workspaces w where w.id = affected_workspace_id)
    and not exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = affected_workspace_id and wm.role = 'owner'
    ) then
    raise exception 'A workspace must retain at least one owner';
  end if;
  return null;
end;
$$;

create constraint trigger workspace_members_preserve_owner
after delete or update of role, workspace_id on public.workspace_members
deferrable initially immediate
for each row execute function public.preserve_workspace_owner();

create or replace function public.try_uuid(value text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function public.hybrid_search_document_chunks(
  target_workspace_id uuid,
  query_text text,
  query_embedding extensions.vector(768),
  target_run_id uuid default null,
  match_count integer default 10,
  rrf_k integer default 60
)
returns table (
  chunk_id uuid,
  document_id uuid,
  content text,
  source_url text,
  lexical_rank bigint,
  semantic_rank bigint,
  lexical_score double precision,
  vector_score double precision,
  fused_score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with lexical as (
    select
      dc.id,
      ts_rank_cd(dc.fts, websearch_to_tsquery('english'::regconfig, query_text))::double precision as score,
      row_number() over (
        order by ts_rank_cd(dc.fts, websearch_to_tsquery('english'::regconfig, query_text)) desc, dc.id
      ) as rank_position
    from public.document_chunks dc
    where dc.workspace_id = target_workspace_id
      and (target_run_id is null or dc.run_id = target_run_id)
      and public.is_workspace_member(dc.workspace_id)
      and dc.fts @@ websearch_to_tsquery('english'::regconfig, query_text)
    order by score desc, dc.id
    limit greatest(1, least(match_count * 4, 200))
  ),
  semantic as (
    select
      dc.id,
      (1 - (dc.embedding <=> query_embedding))::double precision as score,
      row_number() over (order by dc.embedding <=> query_embedding, dc.id) as rank_position
    from public.document_chunks dc
    where dc.workspace_id = target_workspace_id
      and (target_run_id is null or dc.run_id = target_run_id)
      and public.is_workspace_member(dc.workspace_id)
      and dc.embedding is not null
      and query_embedding is not null
    order by dc.embedding <=> query_embedding, dc.id
    limit greatest(1, least(match_count * 4, 200))
  ),
  fused as (
    select
      coalesce(l.id, s.id) as id,
      l.rank_position as lexical_rank,
      s.rank_position as semantic_rank,
      l.score as lexical_score,
      s.score as vector_score,
      (
        coalesce(1.0 / (greatest(rrf_k, 1) + l.rank_position), 0) +
        coalesce(1.0 / (greatest(rrf_k, 1) + s.rank_position), 0)
      )::double precision as fused_score
    from lexical l
    full outer join semantic s on s.id = l.id
  )
  select
    dc.id,
    dc.document_id,
    dc.content,
    d.source_url,
    f.lexical_rank,
    f.semantic_rank,
    f.lexical_score,
    f.vector_score,
    f.fused_score
  from fused f
  join public.document_chunks dc on dc.id = f.id
  join public.documents d on d.id = dc.document_id
  order by f.fused_score desc, dc.id
  limit greatest(1, least(match_count, 100));
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.runs enable row level security;
alter table public.run_snapshots enable row level security;
alter table public.run_stages enable row level security;
alter table public.sources enable row level security;
alter table public.evidence_records enable row level security;
alter table public.literature_records enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.retrievals enable row level security;
alter table public.retrieval_results enable row level security;
alter table public.jobs enable row level security;
alter table public.artifacts enable row level security;
alter table public.run_events enable row level security;

create policy workspaces_select_member on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy workspaces_update_admin on public.workspaces
  for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete_owner on public.workspaces
  for delete to authenticated
  using (public.has_workspace_role(id, array['owner']::public.workspace_role[]));

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy workspace_members_insert_admin on public.workspace_members
  for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and (
      role <> 'owner'
      or public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
    )
  );
create policy workspace_members_update_admin on public.workspace_members
  for update to authenticated
  using (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and (
      role <> 'owner'
      or public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
    )
  )
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and (
      role <> 'owner'
      or public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
    )
  );
create policy workspace_members_delete_admin on public.workspace_members
  for delete to authenticated
  using (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and (
      role <> 'owner'
      or public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[])
    )
  );

create policy projects_select_member on public.projects
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy projects_insert_writer on public.projects
  for insert to authenticated
  with check (public.can_write_workspace(workspace_id) and created_by = (select auth.uid()));
create policy projects_update_writer on public.projects
  for update to authenticated
  using (public.can_write_workspace(workspace_id))
  with check (public.can_write_workspace(workspace_id));
create policy projects_delete_admin on public.projects
  for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy runs_select_member on public.runs
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy run_snapshots_select_member on public.run_snapshots
  for select to authenticated
  using (workspace_id is not null and public.is_workspace_member(workspace_id));
create policy run_snapshots_insert_writer on public.run_snapshots
  for insert to authenticated
  with check (
    workspace_id is not null
    and created_by = (select auth.uid())
    and public.can_write_workspace(workspace_id)
  );
create policy run_snapshots_update_creator on public.run_snapshots
  for update to authenticated
  using (created_by = (select auth.uid()) and public.can_write_workspace(workspace_id))
  with check (created_by = (select auth.uid()) and public.can_write_workspace(workspace_id));
create policy run_stages_select_member on public.run_stages
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy sources_select_member on public.sources
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy evidence_records_select_member on public.evidence_records
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy literature_records_select_member on public.literature_records
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy documents_select_member on public.documents
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy document_chunks_select_member on public.document_chunks
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy retrievals_select_member on public.retrievals
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy retrieval_results_select_member on public.retrieval_results
  for select to authenticated using (
    exists (
      select 1 from public.retrievals r
      where r.id = retrieval_id and public.is_workspace_member(r.workspace_id)
    )
  );
create policy jobs_select_member on public.jobs
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy artifacts_select_member on public.artifacts
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy run_events_select_member on public.run_events
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke all on public.workspaces, public.workspace_members, public.projects, public.runs,
  public.run_snapshots, public.run_stages, public.sources, public.evidence_records,
  public.literature_records, public.documents, public.document_chunks, public.retrievals,
  public.retrieval_results, public.jobs, public.artifacts, public.run_events from anon;
revoke all on sequence public.run_events_id_seq from anon;
grant usage on schema public to authenticated, service_role;
grant select on public.workspaces, public.workspace_members, public.projects, public.runs,
  public.run_snapshots, public.run_stages, public.sources, public.evidence_records,
  public.literature_records, public.documents, public.document_chunks, public.retrievals,
  public.retrieval_results, public.jobs, public.artifacts, public.run_events to authenticated;
grant insert, update on public.run_snapshots to authenticated;
grant insert (workspace_id, user_id, role, invited_by), update (role), delete
  on public.workspace_members to authenticated;
grant insert (workspace_id, name, description, created_by), update (name, description), delete
  on public.projects to authenticated;
grant update (name, slug), delete on public.workspaces to authenticated;
grant all on public.workspaces, public.workspace_members, public.projects, public.runs,
  public.run_snapshots, public.run_stages, public.sources, public.evidence_records,
  public.literature_records, public.documents, public.document_chunks, public.retrievals,
  public.retrieval_results, public.jobs, public.artifacts, public.run_events to service_role;
grant usage, select on sequence public.run_events_id_seq to service_role;

revoke all on function public.create_workspace(text, text) from public, anon;
revoke all on function public.ensure_default_workspace() from public, anon;
revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke all on function public.can_write_workspace(uuid) from public, anon;
revoke all on function public.try_uuid(text) from public, anon;
revoke all on function public.hybrid_search_document_chunks(uuid, text, extensions.vector, uuid, integer, integer)
  from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated, service_role;
grant execute on function public.ensure_default_workspace() to authenticated, service_role;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated, service_role;
grant execute on function public.can_write_workspace(uuid) to authenticated, service_role;
grant execute on function public.try_uuid(text) to authenticated, service_role;
grant execute on function public.hybrid_search_document_chunks(uuid, text, extensions.vector, uuid, integer, integer)
  to authenticated, service_role;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('source-raw', 'source-raw', false, 104857600),
  ('structures', 'structures', false, 262144000),
  ('run-artifacts', 'run-artifacts', false, 524288000),
  ('reports', 'reports', false, 104857600),
  ('job-logs', 'job-logs', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy axiom_storage_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id in ('source-raw', 'structures', 'run-artifacts', 'reports', 'job-logs')
    and public.is_workspace_member(public.try_uuid((storage.foldername(name))[1]))
  );
create policy axiom_storage_insert_writer on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('source-raw', 'structures', 'run-artifacts', 'reports', 'job-logs')
    and public.can_write_workspace(public.try_uuid((storage.foldername(name))[1]))
  );
create policy axiom_storage_update_writer on storage.objects
  for update to authenticated
  using (
    bucket_id in ('source-raw', 'structures', 'run-artifacts', 'reports', 'job-logs')
    and public.can_write_workspace(public.try_uuid((storage.foldername(name))[1]))
    and (
      bucket_id not in ('source-raw', 'run-artifacts')
      or public.has_workspace_role(
        public.try_uuid((storage.foldername(name))[1]),
        array['owner', 'admin']::public.workspace_role[]
      )
    )
  )
  with check (
    bucket_id in ('source-raw', 'structures', 'run-artifacts', 'reports', 'job-logs')
    and public.can_write_workspace(public.try_uuid((storage.foldername(name))[1]))
    and (
      bucket_id not in ('source-raw', 'run-artifacts')
      or public.has_workspace_role(
        public.try_uuid((storage.foldername(name))[1]),
        array['owner', 'admin']::public.workspace_role[]
      )
    )
  );
create policy axiom_storage_delete_writer on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('source-raw', 'structures', 'run-artifacts', 'reports', 'job-logs')
    and public.can_write_workspace(public.try_uuid((storage.foldername(name))[1]))
    and (
      bucket_id not in ('source-raw', 'run-artifacts')
      or public.has_workspace_role(
        public.try_uuid((storage.foldername(name))[1]),
        array['owner', 'admin']::public.workspace_role[]
      )
    )
  );

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pgmq') then
    if pg_catalog.to_regclass('pgmq.q_evidence_ingest') is null then
      perform pgmq.create('evidence_ingest');
    end if;
    if pg_catalog.to_regclass('pgmq.q_embedding_jobs') is null then
      perform pgmq.create('embedding_jobs');
    end if;
    if pg_catalog.to_regclass('pgmq.q_scientific_compute') is null then
      perform pgmq.create('scientific_compute');
    end if;
  end if;
end;
$$;

do $$
declare
  relation_name text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach relation_name in array array['runs', 'run_stages', 'jobs'] loop
      if not exists (
        select 1 from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = relation_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', relation_name);
      end if;
    end loop;
  end if;
end;
$$;

commit;

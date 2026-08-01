begin;

-- Axiom's first indexed RAG model is Supabase/gte-small. It emits 384
-- dimensions. No production embeddings are active yet, so explicitly clear
-- any experimental values before changing the vector typmods and operator
-- class. The JSON run snapshot remains the backwards-compatible API record.

drop function if exists public.hybrid_search_document_chunks(
  uuid,
  text,
  extensions.vector,
  uuid,
  integer,
  integer
);

drop index if exists public.document_chunks_embedding_hnsw_idx;

alter table public.retrievals
  add column if not exists embedding_revision text;

update public.document_chunks
set
  embedding = null,
  embedding_model = null,
  embedding_revision = null
where embedding is not null
   or embedding_model is not null
   or embedding_revision is not null;

update public.retrievals
set
  query_embedding = null,
  embedding_model = null,
  embedding_revision = null
where query_embedding is not null
   or embedding_model is not null
   or embedding_revision is not null;

alter table public.document_chunks
  alter column embedding type extensions.vector(384)
  using null::extensions.vector(384);

alter table public.retrievals
  alter column query_embedding type extensions.vector(384)
  using null::extensions.vector(384);

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.document_chunks'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ilike '%embedding%'
  loop
    execute format(
      'alter table public.document_chunks drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;

alter table public.document_chunks
  add constraint document_chunks_embedding_provenance_check
  check (
    (
      embedding is null
      and embedding_model is null
      and embedding_revision is null
    )
    or
    (
      embedding is not null
      and nullif(btrim(embedding_model), '') is not null
      and nullif(btrim(embedding_revision), '') is not null
    )
  );

alter table public.retrievals
  add constraint retrievals_embedding_provenance_check
  check (
    (
      query_embedding is null
      and embedding_model is null
      and embedding_revision is null
    )
    or
    (
      query_embedding is not null
      and nullif(btrim(embedding_model), '') is not null
      and nullif(btrim(embedding_revision), '') is not null
    )
  );

create unique index if not exists document_chunks_document_index_uidx
  on public.document_chunks (document_id, chunk_index);

create index document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_ip_ops)
  where embedding is not null;

alter table public.evidence_records
  add column if not exists score_semantics text;

update public.evidence_records
set score_semantics = 'source_native_rank_not_confidence'
where score_semantics is null;

alter table public.evidence_records
  alter column score_semantics set default 'source_native_rank_not_confidence',
  alter column score_semantics set not null;

create table public.run_associations (
  run_id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  target_id text not null,
  disease_id text not null,
  upstream_score double precision,
  score_semantics text not null default 'open_targets_association_rank_not_confidence',
  datatype_scores jsonb not null default '[]'::jsonb
    check (jsonb_typeof(datatype_scores) = 'array'),
  datasource_scores jsonb not null default '[]'::jsonb
    check (jsonb_typeof(datasource_scores) = 'array'),
  direct_match boolean not null default false,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, workspace_id),
  foreign key (run_id, workspace_id)
    references public.runs(id, workspace_id) on delete cascade
);

create index run_associations_workspace_run_idx
  on public.run_associations (workspace_id, run_id);

create trigger run_associations_set_updated_at
before update on public.run_associations
for each row execute function public.set_updated_at();

alter table public.run_associations enable row level security;

create policy run_associations_select_member on public.run_associations
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.run_associations from public, anon;
grant select on public.run_associations to authenticated;
grant all on public.run_associations to service_role;

-- Persist a complete normalized evidence bundle and its compatibility snapshot
-- in one Postgres transaction. The caller and workspace are always derived
-- from the Supabase JWT. UUIDs in child arrays are identities only; they can
-- never choose a workspace or run.
create or replace function public.persist_evidence_run_v1(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_workspace_id uuid;
  v_run jsonb;
  v_snapshot jsonb;
  v_association jsonb;
  v_evidence_items jsonb;
  v_literature_items jsonb;
  v_item jsonb;
  v_run_id uuid;
  v_item_id uuid;
  v_source_id uuid;
  v_literature_id uuid;
  v_evidence_id uuid;
  v_document_id uuid;
  v_run_status public.run_status;
  v_stage_status public.stage_status;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_content text;
  v_content_sha256 text;
  v_stage_count integer := 0;
  v_source_count integer := 0;
  v_evidence_count integer := 0;
  v_literature_count integer := 0;
  v_document_count integer := 0;
  v_chunk_count integer := 0;
  v_affected_count integer := 0;
begin
  if v_caller_id is null then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'p_payload must be a JSON object'
      using errcode = '22023';
  end if;

  v_run := p_payload -> 'run';
  v_snapshot := p_payload -> 'snapshot';
  v_association := p_payload -> 'association';

  -- The Worker contract names normalized rows after their destination record
  -- types. Keep the shorter pre-contract aliases for one-way compatibility,
  -- but reject ambiguous payloads instead of silently dropping either array.
  if (p_payload ? 'evidenceRecords') and (p_payload ? 'evidence') then
    raise exception 'Supply evidenceRecords, not both evidenceRecords and evidence'
      using errcode = '22023';
  end if;
  if (p_payload ? 'literatureRecords') and (p_payload ? 'literature') then
    raise exception 'Supply literatureRecords, not both literatureRecords and literature'
      using errcode = '22023';
  end if;

  v_evidence_items := case
    when p_payload ? 'evidenceRecords' then p_payload -> 'evidenceRecords'
    when p_payload ? 'evidence' then p_payload -> 'evidence'
    else '[]'::jsonb
  end;
  v_literature_items := case
    when p_payload ? 'literatureRecords' then p_payload -> 'literatureRecords'
    when p_payload ? 'literature' then p_payload -> 'literature'
    else '[]'::jsonb
  end;

  if jsonb_typeof(v_run) <> 'object' then
    raise exception 'p_payload.run must be a JSON object'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_snapshot) <> 'object' then
    raise exception 'p_payload.snapshot must be a JSON object'
      using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_payload -> 'stages', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload -> 'sources', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(v_evidence_items) <> 'array'
    or jsonb_typeof(v_literature_items) <> 'array'
    or jsonb_typeof(coalesce(p_payload -> 'documents', '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_payload -> 'chunks', '[]'::jsonb)) <> 'array'
  then
    raise exception 'Normalized collection fields must be JSON arrays'
      using errcode = '22023';
  end if;

  v_run_id := public.try_uuid(v_run ->> 'id');
  if v_run_id is null then
    raise exception 'p_payload.run.id must be a UUID'
      using errcode = '22023';
  end if;
  if public.try_uuid(v_snapshot ->> 'id') is distinct from v_run_id then
    raise exception 'snapshot.id must match run.id'
      using errcode = '22023';
  end if;

  if nullif(btrim(v_run ->> 'schemaVersion'), '') is null
    or nullif(btrim(v_run ->> 'status'), '') is null
    or nullif(btrim(v_run ->> 'targetId'), '') is null
    or nullif(btrim(v_run ->> 'diseaseId'), '') is null
  then
    raise exception 'run schemaVersion, status, targetId and diseaseId are required'
      using errcode = '22023';
  end if;

  begin
    v_run_status := (v_run ->> 'status')::public.run_status;
  exception when invalid_text_representation then
    raise exception 'Unsupported run status: %', v_run ->> 'status'
      using errcode = '22023';
  end;

  v_workspace_id := public.ensure_default_workspace();
  v_created_at := coalesce(
    nullif(v_run ->> 'createdAt', '')::timestamptz,
    now()
  );
  v_updated_at := coalesce(
    nullif(v_run ->> 'updatedAt', '')::timestamptz,
    now()
  );

  -- Serialize ownership checks and retries for the same run without trusting
  -- any client-provided lock key.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_run_id::text, 0)
  );

  if exists (
    select 1
    from public.runs r
    where r.id = v_run_id
      and (
        r.workspace_id is distinct from v_workspace_id
        or r.created_by is distinct from v_caller_id
      )
  ) or exists (
    select 1
    from public.run_snapshots rs
    where rs.id = v_run_id
      and (
        rs.workspace_id is distinct from v_workspace_id
        or rs.created_by is distinct from v_caller_id
      )
  ) then
    raise exception 'Run identifier is owned by another principal'
      using errcode = '42501';
  end if;

  v_snapshot := jsonb_set(v_snapshot, '{id}', to_jsonb(v_run_id::text), true);
  v_snapshot := jsonb_set(v_snapshot, '{workspaceId}', to_jsonb(v_workspace_id::text), true);
  v_snapshot := jsonb_set(v_snapshot, '{createdBy}', to_jsonb(v_caller_id::text), true);

  insert into public.run_snapshots as existing (
    id,
    workspace_id,
    created_by,
    schema_version,
    status,
    target_id,
    disease_id,
    snapshot,
    created_at,
    updated_at
  ) values (
    v_run_id,
    v_workspace_id,
    v_caller_id,
    v_run ->> 'schemaVersion',
    v_run ->> 'status',
    v_run ->> 'targetId',
    v_run ->> 'diseaseId',
    v_snapshot,
    v_created_at,
    v_updated_at
  )
  on conflict (id) do update set
    schema_version = excluded.schema_version,
    status = excluded.status,
    target_id = excluded.target_id,
    disease_id = excluded.disease_id,
    snapshot = excluded.snapshot,
    updated_at = excluded.updated_at
  where existing.workspace_id = v_workspace_id
    and existing.created_by = v_caller_id;
  get diagnostics v_affected_count = row_count;
  if v_affected_count <> 1 then
    raise exception 'Run snapshot ownership changed during persistence'
      using errcode = '42501';
  end if;

  insert into public.runs as existing (
    id,
    workspace_id,
    project_id,
    created_by,
    schema_version,
    status,
    target_id,
    target_label,
    disease_id,
    disease_label,
    research_question,
    input,
    warnings,
    idempotency_key,
    created_at,
    updated_at
  ) values (
    v_run_id,
    v_workspace_id,
    null,
    v_caller_id,
    v_run ->> 'schemaVersion',
    v_run_status,
    v_run ->> 'targetId',
    nullif(v_run ->> 'targetLabel', ''),
    v_run ->> 'diseaseId',
    nullif(v_run ->> 'diseaseLabel', ''),
    nullif(v_run ->> 'researchQuestion', ''),
    coalesce(v_run -> 'input', '{}'::jsonb),
    coalesce(v_run -> 'warnings', '[]'::jsonb),
    nullif(v_run ->> 'idempotencyKey', ''),
    v_created_at,
    v_updated_at
  )
  on conflict (id) do update set
    schema_version = excluded.schema_version,
    status = excluded.status,
    target_id = excluded.target_id,
    target_label = excluded.target_label,
    disease_id = excluded.disease_id,
    disease_label = excluded.disease_label,
    research_question = excluded.research_question,
    input = excluded.input,
    warnings = excluded.warnings,
    idempotency_key = excluded.idempotency_key,
    updated_at = excluded.updated_at
  where existing.workspace_id = v_workspace_id
    and existing.created_by = v_caller_id;
  get diagnostics v_affected_count = row_count;
  if v_affected_count <> 1 then
    raise exception 'Normalized run ownership changed during persistence'
      using errcode = '42501';
  end if;

  if v_association is not null and jsonb_typeof(v_association) <> 'null' then
    if jsonb_typeof(v_association) <> 'object' then
      raise exception 'association must be an object or null'
        using errcode = '22023';
    end if;

    insert into public.run_associations as existing (
      run_id,
      workspace_id,
      target_id,
      disease_id,
      upstream_score,
      score_semantics,
      datatype_scores,
      datasource_scores,
      direct_match,
      payload
    ) values (
      v_run_id,
      v_workspace_id,
      coalesce(nullif(v_association ->> 'targetId', ''), v_run ->> 'targetId'),
      coalesce(nullif(v_association ->> 'diseaseId', ''), v_run ->> 'diseaseId'),
      coalesce(
        nullif(v_association ->> 'upstreamScore', '')::double precision,
        nullif(v_association ->> 'associationScore', '')::double precision
      ),
      coalesce(
        nullif(v_association ->> 'scoreSemantics', ''),
        'open_targets_association_rank_not_confidence'
      ),
      coalesce(v_association -> 'datatypeScores', '[]'::jsonb),
      coalesce(v_association -> 'datasourceScores', '[]'::jsonb),
      coalesce((v_association ->> 'directMatch')::boolean, false),
      coalesce(v_association -> 'payload', v_association)
    )
    on conflict (run_id) do update set
      target_id = excluded.target_id,
      disease_id = excluded.disease_id,
      upstream_score = excluded.upstream_score,
      score_semantics = excluded.score_semantics,
      datatype_scores = excluded.datatype_scores,
      datasource_scores = excluded.datasource_scores,
      direct_match = excluded.direct_match,
      payload = excluded.payload
    where existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Association ownership changed during persistence'
        using errcode = '42501';
    end if;
  end if;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_payload -> 'stages', '[]'::jsonb))
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    if v_item_id is null then
      raise exception 'Every stage.id must be a UUID'
        using errcode = '22023';
    end if;
    if nullif(btrim(v_item ->> 'stageKey'), '') is null then
      raise exception 'Every stage.stageKey is required'
        using errcode = '22023';
    end if;
    begin
      v_stage_status := coalesce(
        nullif(v_item ->> 'status', '')::public.stage_status,
        'pending'::public.stage_status
      );
    exception when invalid_text_representation then
      raise exception 'Unsupported stage status: %', v_item ->> 'status'
        using errcode = '22023';
    end;
    if exists (
      select 1 from public.run_stages s
      where s.id = v_item_id
        and (s.run_id <> v_run_id or s.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Stage identifier is owned by another run'
        using errcode = '42501';
    end if;

    insert into public.run_stages as existing (
      id, workspace_id, run_id, stage_key, status, attempt, progress,
      config, error, started_at, completed_at
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_item ->> 'stageKey',
      v_stage_status,
      coalesce((v_item ->> 'attempt')::integer, 1),
      coalesce((v_item ->> 'progress')::double precision, 0),
      coalesce(v_item -> 'config', '{}'::jsonb),
      v_item -> 'error',
      nullif(v_item ->> 'startedAt', '')::timestamptz,
      nullif(v_item ->> 'completedAt', '')::timestamptz
    )
    on conflict (id) do update set
      stage_key = excluded.stage_key,
      status = excluded.status,
      attempt = excluded.attempt,
      progress = excluded.progress,
      config = excluded.config,
      error = excluded.error,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Stage ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_stage_count := v_stage_count + 1;
  end loop;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_payload -> 'sources', '[]'::jsonb))
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    if v_item_id is null then
      raise exception 'Every source.id must be a UUID'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.sources s
      where s.id = v_item_id
        and (s.run_id <> v_run_id or s.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Source identifier is owned by another run'
        using errcode = '42501';
    end if;

    insert into public.sources as existing (
      id, workspace_id, run_id, provider, source_native_id, endpoint, query,
      license, release_version, retrieved_at, checksum_sha256,
      raw_object_path, metadata
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_item ->> 'provider',
      nullif(v_item ->> 'sourceNativeId', ''),
      v_item ->> 'endpoint',
      coalesce(v_item -> 'query', '{}'::jsonb),
      nullif(v_item ->> 'license', ''),
      nullif(v_item ->> 'releaseVersion', ''),
      coalesce(nullif(v_item ->> 'retrievedAt', '')::timestamptz, now()),
      nullif(lower(v_item ->> 'checksumSha256'), ''),
      nullif(v_item ->> 'rawObjectPath', ''),
      coalesce(v_item -> 'metadata', '{}'::jsonb)
    )
    on conflict (id) do update set
      provider = excluded.provider,
      source_native_id = excluded.source_native_id,
      endpoint = excluded.endpoint,
      query = excluded.query,
      license = excluded.license,
      release_version = excluded.release_version,
      retrieved_at = excluded.retrieved_at,
      checksum_sha256 = excluded.checksum_sha256,
      raw_object_path = excluded.raw_object_path,
      metadata = excluded.metadata
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Source ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_source_count := v_source_count + 1;
  end loop;

  for v_item in
    select value
    from jsonb_array_elements(v_evidence_items)
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    v_source_id := public.try_uuid(nullif(v_item ->> 'sourceId', ''));
    if v_item_id is null then
      raise exception 'Every evidence.id must be a UUID'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.evidence_records e
      where e.id = v_item_id
        and (e.run_id <> v_run_id or e.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Evidence identifier is owned by another run'
        using errcode = '42501';
    end if;

    insert into public.evidence_records as existing (
      id, workspace_id, run_id, source_id, external_id, target_id,
      disease_id, datatype_id, datasource_id, upstream_score,
      score_semantics, literature_ids, study_id, variant_id, drug_id, payload
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_source_id,
      v_item ->> 'externalId',
      coalesce(nullif(v_item ->> 'targetId', ''), v_run ->> 'targetId'),
      coalesce(nullif(v_item ->> 'diseaseId', ''), v_run ->> 'diseaseId'),
      nullif(v_item ->> 'datatypeId', ''),
      nullif(v_item ->> 'datasourceId', ''),
      nullif(v_item ->> 'upstreamScore', '')::double precision,
      coalesce(
        nullif(v_item ->> 'scoreSemantics', ''),
        'open_targets_source_native_rank_not_confidence'
      ),
      array(
        select jsonb_array_elements_text(
          coalesce(v_item -> 'literatureIds', '[]'::jsonb)
        )
      ),
      nullif(v_item ->> 'studyId', ''),
      nullif(v_item ->> 'variantId', ''),
      nullif(v_item ->> 'drugId', ''),
      coalesce(v_item -> 'payload', v_item)
    )
    on conflict (id) do update set
      source_id = excluded.source_id,
      external_id = excluded.external_id,
      target_id = excluded.target_id,
      disease_id = excluded.disease_id,
      datatype_id = excluded.datatype_id,
      datasource_id = excluded.datasource_id,
      upstream_score = excluded.upstream_score,
      score_semantics = excluded.score_semantics,
      literature_ids = excluded.literature_ids,
      study_id = excluded.study_id,
      variant_id = excluded.variant_id,
      drug_id = excluded.drug_id,
      payload = excluded.payload
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Evidence ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_evidence_count := v_evidence_count + 1;
  end loop;

  for v_item in
    select value
    from jsonb_array_elements(v_literature_items)
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    v_source_id := public.try_uuid(nullif(v_item ->> 'sourceId', ''));
    if v_item_id is null then
      raise exception 'Every literature.id must be a UUID'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.literature_records l
      where l.id = v_item_id
        and (l.run_id <> v_run_id or l.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Literature identifier is owned by another run'
        using errcode = '42501';
    end if;

    insert into public.literature_records as existing (
      id, workspace_id, run_id, source_id, external_id, pmid, pmcid, doi,
      title, abstract_text, authors, journal, publication_date,
      cited_by_count, is_open_access, source_url, license, payload
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_source_id,
      v_item ->> 'externalId',
      nullif(v_item ->> 'pmid', ''),
      nullif(v_item ->> 'pmcid', ''),
      nullif(v_item ->> 'doi', ''),
      v_item ->> 'title',
      nullif(v_item ->> 'abstractText', ''),
      nullif(v_item ->> 'authors', ''),
      nullif(v_item ->> 'journal', ''),
      nullif(v_item ->> 'publicationDate', '')::date,
      coalesce((v_item ->> 'citedByCount')::integer, 0),
      coalesce((v_item ->> 'isOpenAccess')::boolean, false),
      nullif(v_item ->> 'sourceUrl', ''),
      nullif(v_item ->> 'license', ''),
      coalesce(v_item -> 'payload', v_item)
    )
    on conflict (id) do update set
      source_id = excluded.source_id,
      external_id = excluded.external_id,
      pmid = excluded.pmid,
      pmcid = excluded.pmcid,
      doi = excluded.doi,
      title = excluded.title,
      abstract_text = excluded.abstract_text,
      authors = excluded.authors,
      journal = excluded.journal,
      publication_date = excluded.publication_date,
      cited_by_count = excluded.cited_by_count,
      is_open_access = excluded.is_open_access,
      source_url = excluded.source_url,
      license = excluded.license,
      payload = excluded.payload
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Literature ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_literature_count := v_literature_count + 1;
  end loop;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_payload -> 'documents', '[]'::jsonb))
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    v_source_id := public.try_uuid(nullif(v_item ->> 'sourceId', ''));
    v_literature_id := public.try_uuid(nullif(v_item ->> 'literatureRecordId', ''));
    v_evidence_id := public.try_uuid(nullif(v_item ->> 'evidenceRecordId', ''));
    if v_item_id is null then
      raise exception 'Every document.id must be a UUID'
        using errcode = '22023';
    end if;
    if pg_catalog.num_nonnulls(v_literature_id, v_evidence_id) <> 1 then
      raise exception 'Every document must reference exactly one literature or evidence record'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.documents d
      where d.id = v_item_id
        and (d.run_id <> v_run_id or d.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Document identifier is owned by another run'
        using errcode = '42501';
    end if;

    v_content := v_item ->> 'content';
    v_content_sha256 := coalesce(
      nullif(lower(v_item ->> 'contentSha256'), ''),
      encode(
        extensions.digest(pg_catalog.convert_to(v_content, 'UTF8'), 'sha256'),
        'hex'
      )
    );

    insert into public.documents as existing (
      id, workspace_id, run_id, source_id, literature_record_id,
      evidence_record_id, document_kind, external_id, title, content,
      source_url, license, content_sha256, metadata
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_source_id,
      v_literature_id,
      v_evidence_id,
      v_item ->> 'documentKind',
      v_item ->> 'externalId',
      nullif(v_item ->> 'title', ''),
      v_content,
      nullif(v_item ->> 'sourceUrl', ''),
      nullif(v_item ->> 'license', ''),
      v_content_sha256,
      coalesce(v_item -> 'metadata', '{}'::jsonb)
    )
    on conflict (id) do update set
      source_id = excluded.source_id,
      literature_record_id = excluded.literature_record_id,
      evidence_record_id = excluded.evidence_record_id,
      document_kind = excluded.document_kind,
      external_id = excluded.external_id,
      title = excluded.title,
      content = excluded.content,
      source_url = excluded.source_url,
      license = excluded.license,
      content_sha256 = excluded.content_sha256,
      metadata = excluded.metadata
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Document ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_document_count := v_document_count + 1;
  end loop;

  for v_item in
    select value
    from jsonb_array_elements(coalesce(p_payload -> 'chunks', '[]'::jsonb))
  loop
    v_item_id := public.try_uuid(v_item ->> 'id');
    v_document_id := public.try_uuid(v_item ->> 'documentId');
    if v_item_id is null or v_document_id is null then
      raise exception 'Every chunk.id and chunk.documentId must be UUIDs'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from public.document_chunks dc
      where dc.id = v_item_id
        and (dc.run_id <> v_run_id or dc.workspace_id <> v_workspace_id)
    ) then
      raise exception 'Chunk identifier is owned by another run'
        using errcode = '42501';
    end if;

    v_content := v_item ->> 'content';
    v_content_sha256 := coalesce(
      nullif(lower(v_item ->> 'contentSha256'), ''),
      encode(
        extensions.digest(pg_catalog.convert_to(v_content, 'UTF8'), 'sha256'),
        'hex'
      )
    );

    insert into public.document_chunks as existing (
      id, workspace_id, run_id, document_id, chunk_index, content,
      content_sha256, token_count, embedding, embedding_model,
      embedding_revision
    ) values (
      v_item_id,
      v_workspace_id,
      v_run_id,
      v_document_id,
      (v_item ->> 'chunkIndex')::integer,
      v_content,
      v_content_sha256,
      nullif(v_item ->> 'tokenCount', '')::integer,
      null,
      null,
      null
    )
    on conflict (id) do update set
      document_id = excluded.document_id,
      chunk_index = excluded.chunk_index,
      content = excluded.content,
      content_sha256 = excluded.content_sha256,
      token_count = excluded.token_count,
      embedding = case
        when existing.content_sha256 = excluded.content_sha256 then existing.embedding
        else null
      end,
      embedding_model = case
        when existing.content_sha256 = excluded.content_sha256 then existing.embedding_model
        else null
      end,
      embedding_revision = case
        when existing.content_sha256 = excluded.content_sha256 then existing.embedding_revision
        else null
      end
    where existing.run_id = v_run_id
      and existing.workspace_id = v_workspace_id;
    get diagnostics v_affected_count = row_count;
    if v_affected_count <> 1 then
      raise exception 'Chunk ownership changed during persistence'
        using errcode = '42501';
    end if;
    v_chunk_count := v_chunk_count + 1;
  end loop;

  return jsonb_build_object(
    'runId', v_run_id,
    'workspaceId', v_workspace_id,
    'createdBy', v_caller_id,
    'normalized', true,
    'snapshot', v_snapshot,
    'counts', jsonb_build_object(
      'stages', v_stage_count,
      'sources', v_source_count,
      'evidenceRecords', v_evidence_count,
      'literatureRecords', v_literature_count,
      'documents', v_document_count,
      'chunks', v_chunk_count
    )
  );
end;
$$;

-- Apply one bounded embedding batch. Only the trusted service worker can write
-- vectors; it derives tenancy from the run. pgvector rejects NaN/Infinity on
-- cast, while an explicit norm check rejects zero or non-normalized vectors.
create or replace function public.apply_chunk_embeddings_v1(
  p_run_id uuid,
  p_model text,
  p_revision text,
  p_items jsonb,
  p_complete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_service boolean := coalesce(auth.role() = 'service_role', false);
  v_workspace_id uuid;
  v_model text := nullif(btrim(p_model), '');
  v_revision text := nullif(btrim(p_revision), '');
  v_item jsonb;
  v_chunk_id uuid;
  v_embedding extensions.vector(384);
  v_norm_squared double precision;
  v_item_count integer;
  v_updated_count integer := 0;
  v_total_count integer;
  v_matching_count integer;
  v_null_count integer;
  v_stage_id uuid;
  v_progress double precision;
begin
  if not v_is_service then
    raise exception 'Only the trusted embedding worker may write vectors'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'p_run_id is required'
      using errcode = '22023';
  end if;
  if v_model is null
    or v_revision is null
    or char_length(v_model) > 200
    or char_length(v_revision) > 200
  then
    raise exception 'A bounded embedding model and revision are required'
      using errcode = '22023';
  end if;
  if v_model <> 'Supabase/gte-small'
    or v_revision <> 'supabase-edge-runtime-managed'
  then
    raise exception 'Unsupported embedding model or revision'
      using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a JSON array'
      using errcode = '22023';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count > 100 then
    raise exception 'At most 100 embeddings may be applied per call'
      using errcode = '22023';
  end if;
  if (
    select count(distinct coalesce(value ->> 'chunkId', value ->> 'id'))
    from jsonb_array_elements(p_items)
  ) <> v_item_count then
    raise exception 'Embedding id values must be present and unique within a batch'
      using errcode = '22023';
  end if;

  -- Use the same run-scoped lock as normalized persistence so a concurrent
  -- ingest cannot add/reset a chunk after the completion count is checked.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_run_id::text, 0)
  );

  select r.workspace_id
  into v_workspace_id
  from public.runs r
  where r.id = p_run_id
    and v_is_service;

  if v_workspace_id is null then
    raise exception 'Run does not exist or is not writable by the caller'
      using errcode = '42501';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_items)
  loop
    if (v_item ? 'chunkId')
      and (v_item ? 'id')
      and public.try_uuid(v_item ->> 'chunkId')
        is distinct from public.try_uuid(v_item ->> 'id')
    then
      raise exception 'Embedding id and chunkId must match when both are supplied'
        using errcode = '22023';
    end if;

    v_chunk_id := coalesce(
      public.try_uuid(nullif(v_item ->> 'chunkId', '')),
      public.try_uuid(nullif(v_item ->> 'id', ''))
    );
    if v_chunk_id is null then
      raise exception 'Every embedding id or chunkId must be a UUID'
        using errcode = '22023';
    end if;
    if jsonb_typeof(v_item -> 'embedding') <> 'array'
      or jsonb_array_length(v_item -> 'embedding') <> 384
      or exists (
        select 1
        from jsonb_array_elements(v_item -> 'embedding')
          as embedding_component(component)
        where jsonb_typeof(component) <> 'number'
      )
    then
      raise exception 'Every embedding must contain exactly 384 numeric values'
        using errcode = '22023';
    end if;

    begin
      v_embedding := ((v_item -> 'embedding')::text)::extensions.vector(384);
    exception when others then
      raise exception 'Embedding for chunk % is not a finite 384-vector', v_chunk_id
        using errcode = '22023';
    end;

    v_norm_squared := -(
      v_embedding operator(extensions.<#>) v_embedding
    );
    if v_norm_squared <= 0 then
      raise exception 'Embedding for chunk % must be nonzero', v_chunk_id
        using errcode = '22023';
    end if;
    if abs(v_norm_squared - 1.0) > 0.002 then
      raise exception 'Embedding for chunk % must be unit-normalized', v_chunk_id
        using errcode = '22023';
    end if;

    update public.document_chunks dc
    set
      embedding = v_embedding,
      embedding_model = v_model,
      embedding_revision = v_revision
    where dc.id = v_chunk_id
      and dc.run_id = p_run_id
      and dc.workspace_id = v_workspace_id;

    if not found then
      raise exception 'Chunk % does not belong to the authorized run', v_chunk_id
        using errcode = '42501';
    end if;
    v_updated_count := v_updated_count + 1;
  end loop;

  select
    count(*),
    count(*) filter (
      where dc.embedding is not null
        and dc.embedding_model = v_model
        and dc.embedding_revision = v_revision
    ),
    count(*) filter (where dc.embedding is null)
  into v_total_count, v_matching_count, v_null_count
  from public.document_chunks dc
  where dc.run_id = p_run_id
    and dc.workspace_id = v_workspace_id;

  v_progress := case
    when v_total_count = 0 then 0
    else v_matching_count::double precision / v_total_count::double precision
  end;

  select rs.id
  into v_stage_id
  from public.run_stages rs
  where rs.run_id = p_run_id
    and rs.workspace_id = v_workspace_id
    and rs.stage_key = 'rag_index'
  order by rs.attempt desc
  limit 1;

  if v_stage_id is null then
    raise exception 'The run is missing its rag_index stage'
      using errcode = '55000';
  end if;

  if coalesce(p_complete, false) then
    if v_null_count <> 0
      or v_matching_count <> v_total_count
    then
      raise exception 'RAG indexing cannot complete until every chunk has a matching embedding'
        using errcode = '55000';
    end if;

    update public.run_stages
    set
      status = 'completed',
      progress = 1,
      completed_at = now(),
      error = null,
      config = config || jsonb_build_object(
        'embeddingModel', v_model,
        'embeddingRevision', v_revision,
        'embeddingDimensions', 384
      )
    where id = v_stage_id;
  else
    update public.run_stages
    set
      status = case when status = 'pending' then 'running' else status end,
      progress = least(1, greatest(0, v_progress)),
      started_at = coalesce(started_at, now()),
      config = config || jsonb_build_object(
        'embeddingModel', v_model,
        'embeddingRevision', v_revision,
        'embeddingDimensions', 384
      )
    where id = v_stage_id;
  end if;

  return jsonb_build_object(
    'runId', p_run_id,
    'workspaceId', v_workspace_id,
    'updated', v_updated_count,
    'totalChunks', v_total_count,
    'embeddedChunks', v_matching_count,
    'matchingEmbeddings', v_matching_count,
    'remainingNullEmbeddings', v_null_count,
    'complete', coalesce(p_complete, false),
    'model', v_model,
    'revision', v_revision,
    'dimensions', 384
  );
end;
$$;

-- Execute and audit a run-scoped retrieval. Exact vector ranking is
-- intentional at this milestone: the run filter is applied before distance
-- calculation, avoiding filtered-ANN under-return while each run is small.
create or replace function public.execute_run_retrieval_v2(
  p_run_id uuid,
  p_query_text text,
  p_query_embedding extensions.vector(384) default null,
  p_embedding_model text default null,
  p_embedding_revision text default null,
  p_top_k integer default 8,
  p_rrf_k integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_is_service boolean := coalesce(auth.role() = 'service_role', false);
  v_workspace_id uuid;
  v_retrieval_id uuid := gen_random_uuid();
  v_query text := btrim(coalesce(p_query_text, ''));
  v_embedding_model text := nullif(btrim(p_embedding_model), '');
  v_embedding_revision text := nullif(btrim(p_embedding_revision), '');
  v_query_tsquery tsquery;
  v_mode text;
  v_use_semantic boolean := false;
  v_total_candidates integer := 0;
  v_semantic_candidates integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_result_count integer := 0;
  v_results_with_citations integer := 0;
  v_warnings jsonb := jsonb_build_array(
    'Retrieval scores are ranking signals, not probabilities or confidence estimates.'
  );
begin
  if v_caller_id is null and not v_is_service then
    raise exception 'Authentication is required'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'p_run_id is required'
      using errcode = '22023';
  end if;
  if char_length(v_query) < 3 or char_length(v_query) > 500 then
    raise exception 'Query must be between 3 and 500 characters after trimming'
      using errcode = '22023';
  end if;
  if p_top_k is null or p_top_k < 1 or p_top_k > 20 then
    raise exception 'p_top_k must be between 1 and 20'
      using errcode = '22023';
  end if;
  if p_rrf_k is null or p_rrf_k < 1 or p_rrf_k > 1000 then
    raise exception 'p_rrf_k must be between 1 and 1000'
      using errcode = '22023';
  end if;
  if pg_catalog.num_nonnulls(
    p_query_embedding,
    v_embedding_model,
    v_embedding_revision
  ) not in (0, 3) then
    raise exception 'Query embedding, model and revision must be supplied together'
      using errcode = '22023';
  end if;
  if char_length(v_embedding_model) > 200
    or char_length(v_embedding_revision) > 200
  then
    raise exception 'Embedding model and revision must be at most 200 characters'
      using errcode = '22023';
  end if;
  if p_query_embedding is not null
    and -(p_query_embedding operator(extensions.<#>) p_query_embedding) <= 0
  then
    raise exception 'Query embedding must be nonzero'
      using errcode = '22023';
  end if;

  select r.workspace_id
  into v_workspace_id
  from public.runs r
  where r.id = p_run_id
    and (
      v_is_service
      or public.is_workspace_member(r.workspace_id)
    );

  if v_workspace_id is null then
    raise exception 'Run does not exist or is not visible to the caller'
      using errcode = '42501';
  end if;

  v_query_tsquery := websearch_to_tsquery('english'::regconfig, v_query);

  select count(*)
  into v_total_candidates
  from public.document_chunks dc
  where dc.run_id = p_run_id
    and dc.workspace_id = v_workspace_id;

  if p_query_embedding is not null then
    select count(*)
    into v_semantic_candidates
    from public.document_chunks dc
    where dc.run_id = p_run_id
      and dc.workspace_id = v_workspace_id
      and dc.embedding is not null
      and dc.embedding_model = v_embedding_model
      and dc.embedding_revision = v_embedding_revision;
    v_use_semantic := v_semantic_candidates > 0;
  end if;

  v_mode := case
    when v_use_semantic then 'hybrid_rrf_v2'
    else 'postgres_fts_v1'
  end;

  if p_query_embedding is not null and not v_use_semantic then
    v_warnings := v_warnings || jsonb_build_array(
      'No chunks matched the requested embedding model and revision; lexical retrieval was used.'
    );
  end if;

  insert into public.retrievals (
    id,
    workspace_id,
    run_id,
    created_by,
    query,
    retrieval_mode,
    generated,
    top_k,
    embedding_model,
    embedding_revision,
    query_embedding,
    metadata
  ) values (
    v_retrieval_id,
    v_workspace_id,
    p_run_id,
    v_caller_id,
    v_query,
    v_mode,
    false,
    p_top_k,
    case when v_use_semantic then v_embedding_model else null end,
    case when v_use_semantic then v_embedding_revision else null end,
    case when v_use_semantic then p_query_embedding else null end,
    jsonb_build_object(
      'rrfK', p_rrf_k,
      'embeddingDimensions', case when v_use_semantic then 384 else null end,
      'totalCandidates', v_total_candidates,
      'semanticCandidates', v_semantic_candidates,
      'scoreSemantics', jsonb_build_object(
        'lexicalScore', 'Postgres text-search rank; not confidence',
        'vectorScore', 'inner-product similarity; not confidence',
        'fusedScore', 'reciprocal-rank fusion value; not confidence'
      )
    )
  );

  with eligible as materialized (
    select
      dc.id as chunk_id,
      dc.document_id,
      dc.content,
      dc.fts,
      dc.embedding,
      dc.embedding_model,
      dc.embedding_revision,
      d.document_kind,
      d.external_id,
      d.title,
      d.source_url,
      d.license,
      s.provider,
      s.source_native_id,
      lr.pmid,
      lr.pmcid,
      lr.doi,
      er.datatype_id,
      er.datasource_id,
      case
        when jsonb_typeof(d.metadata -> 'citations') = 'array'
          then d.metadata -> 'citations'
        else (
          jsonb_build_array(d.external_id)
          || case
            when lr.pmid is null then '[]'::jsonb
            else jsonb_build_array('PMID:' || lr.pmid)
          end
          || case
            when lr.pmcid is null then '[]'::jsonb
            else jsonb_build_array('PMCID:' || lr.pmcid)
          end
          || case
            when lr.doi is null then '[]'::jsonb
            else jsonb_build_array('DOI:' || lr.doi)
          end
          || coalesce(
            (
              select jsonb_agg('PMID:' || literature_id)
              from unnest(coalesce(er.literature_ids, '{}'::text[])) literature_id
            ),
            '[]'::jsonb
          )
        )
      end as citations,
      jsonb_strip_nulls(jsonb_build_object(
        'sourceId', s.provider,
        'sourceNativeId', s.source_native_id,
        'recordId', d.external_id,
        'pmid', lr.pmid,
        'pmcid', lr.pmcid,
        'doi', lr.doi,
        'datatypeId', er.datatype_id,
        'datasourceId', er.datasource_id,
        'license', d.license
      )) || case
        when jsonb_typeof(d.metadata -> 'provenance') = 'object'
          then d.metadata -> 'provenance'
        else '{}'::jsonb
      end as provenance
    from public.document_chunks dc
    join public.documents d
      on d.id = dc.document_id
      and d.run_id = dc.run_id
      and d.workspace_id = dc.workspace_id
    left join public.sources s
      on s.id = d.source_id
      and s.run_id = d.run_id
      and s.workspace_id = d.workspace_id
    left join public.literature_records lr
      on lr.id = d.literature_record_id
      and lr.run_id = d.run_id
      and lr.workspace_id = d.workspace_id
    left join public.evidence_records er
      on er.id = d.evidence_record_id
      and er.run_id = d.run_id
      and er.workspace_id = d.workspace_id
    where dc.run_id = p_run_id
      and dc.workspace_id = v_workspace_id
  ),
  lexical as (
    select
      e.chunk_id,
      ts_rank_cd(e.fts, v_query_tsquery)::double precision as lexical_score,
      row_number() over (
        order by ts_rank_cd(e.fts, v_query_tsquery) desc, e.chunk_id
      ) as lexical_rank
    from eligible e
    where e.fts @@ v_query_tsquery
    order by lexical_score desc, e.chunk_id
    limit least(p_top_k * 8, 160)
  ),
  semantic as (
    select
      e.chunk_id,
      (-(e.embedding operator(extensions.<#>) p_query_embedding))::double precision
        as vector_score,
      row_number() over (
        order by e.embedding operator(extensions.<#>) p_query_embedding, e.chunk_id
      ) as semantic_rank
    from eligible e
    where v_use_semantic
      and e.embedding is not null
      and e.embedding_model = v_embedding_model
      and e.embedding_revision = v_embedding_revision
    order by e.embedding operator(extensions.<#>) p_query_embedding, e.chunk_id
    limit least(p_top_k * 8, 160)
  ),
  fused as (
    select
      coalesce(l.chunk_id, s.chunk_id) as chunk_id,
      l.lexical_rank,
      s.semantic_rank,
      l.lexical_score,
      s.vector_score,
      (
        coalesce(1.0 / (p_rrf_k + l.lexical_rank), 0)
        + coalesce(1.0 / (p_rrf_k + s.semantic_rank), 0)
      )::double precision as fused_score
    from lexical l
    full outer join semantic s on s.chunk_id = l.chunk_id
  ),
  ranked as (
    select
      f.*,
      row_number() over (
        order by f.fused_score desc, f.chunk_id
      )::integer as result_rank
    from fused f
    order by f.fused_score desc, f.chunk_id
    limit p_top_k
  ),
  inserted as (
    insert into public.retrieval_results (
      workspace_id,
      run_id,
      retrieval_id,
      chunk_id,
      rank,
      lexical_score,
      vector_score,
      fused_score,
      citations
    )
    select
      v_workspace_id,
      p_run_id,
      v_retrieval_id,
      r.chunk_id,
      r.result_rank,
      r.lexical_score,
      r.vector_score,
      r.fused_score,
      e.citations
    from ranked r
    join eligible e on e.chunk_id = r.chunk_id
    returning chunk_id, rank, lexical_score, vector_score, fused_score, citations
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', e.chunk_id,
          'chunkId', e.chunk_id,
          'documentId', e.document_id,
          'sourceType', e.document_kind,
          'title', coalesce(e.title, e.external_id),
          'excerpt', left(e.content, 600),
          'score', i.fused_score,
          'lexicalScore', i.lexical_score,
          'vectorScore', i.vector_score,
          'fusedScore', i.fused_score,
          'rank', i.rank,
          'lexicalRank', r.lexical_rank,
          'semanticRank', r.semantic_rank,
          'scores', jsonb_build_object(
            'lexical', i.lexical_score,
            'vector', i.vector_score,
            'fused', i.fused_score
          ),
          'ranks', jsonb_build_object(
            'lexical', r.lexical_rank,
            'semantic', r.semantic_rank
          ),
          'scoreMeaning', 'Retrieval rank values; not probabilities or confidence estimates.',
          'sourceUrl', e.source_url,
          'citations', i.citations,
          'provenance', e.provenance
        ) order by i.rank
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    count(*) filter (where jsonb_array_length(e.citations) > 0)::integer
  into v_results, v_result_count, v_results_with_citations
  from inserted i
  join ranked r on r.chunk_id = i.chunk_id
  join eligible e on e.chunk_id = i.chunk_id;

  return jsonb_build_object(
    'retrievalId', v_retrieval_id,
    'runId', p_run_id,
    'query', v_query,
    'retrievalMode', v_mode,
    'generated', false,
    'totalCandidates', v_total_candidates,
    'semanticCandidates', v_semantic_candidates,
    'model', case when v_use_semantic then v_embedding_model else null end,
    'revision', case when v_use_semantic then v_embedding_revision else null end,
    'embedding', jsonb_build_object(
      'model', case when v_use_semantic then v_embedding_model else null end,
      'revision', case when v_use_semantic then v_embedding_revision else null end,
      'dimensions', case when v_use_semantic then 384 else null end,
      'normalized', v_use_semantic
    ),
    'workflow', jsonb_build_array(
      jsonb_build_object('step', 'planner', 'label', 'Query planner', 'status', 'completed'),
      jsonb_build_object(
        'step', case when v_use_semantic then 'hybrid_retriever' else 'lexical_retriever' end,
        'label', case when v_use_semantic then 'Hybrid retriever' else 'Lexical retriever' end,
        'status', 'completed'
      ),
      jsonb_build_object('step', 'citation_guard', 'label', 'Citation guard', 'status', 'completed')
    ),
    'results', v_results,
    'warnings', v_warnings,
    'citationAudit', jsonb_build_object(
      'status', case
        when v_result_count = v_results_with_citations then 'passed'
        else 'failed'
      end,
      'coverage', case
        when v_result_count = 0 then 1.0
        else v_results_with_citations::double precision / v_result_count::double precision
      end,
      'citedResults', v_results_with_citations,
      'totalResults', v_result_count,
      'resultCount', v_result_count,
      'resultsWithCitations', v_results_with_citations,
      'missingCitationCount', v_result_count - v_results_with_citations,
      'complete', v_result_count = v_results_with_citations
    ),
    'scoreSemantics', jsonb_build_object(
      'lexicalScore', 'Postgres text-search rank; not confidence',
      'vectorScore', 'inner-product similarity; not confidence',
      'fusedScore', 'reciprocal-rank fusion value; not confidence'
    )
  );
end;
$$;

-- The original workspace-scoped RPC cannot prove the model provenance of its
-- caller-supplied vector. Keep its 384-dimensional signature as an explicit
-- compatibility tombstone and direct all application traffic to the run-bound
-- v2 RPC above.
create or replace function public.hybrid_search_document_chunks(
  target_workspace_id uuid,
  query_text text,
  query_embedding extensions.vector(384),
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
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  raise exception 'hybrid_search_document_chunks is superseded by execute_run_retrieval_v2'
    using errcode = '0A000';
end;
$$;

comment on function public.hybrid_search_document_chunks(
  uuid,
  text,
  extensions.vector,
  uuid,
  integer,
  integer
) is 'Deprecated compatibility tombstone. Use execute_run_retrieval_v2.';

revoke all on function public.persist_evidence_run_v1(jsonb) from public, anon;
revoke all on function public.apply_chunk_embeddings_v1(uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.execute_run_retrieval_v2(
  uuid, text, extensions.vector, text, text, integer, integer
) from public, anon;
revoke all on function public.hybrid_search_document_chunks(
  uuid, text, extensions.vector, uuid, integer, integer
) from public, anon, authenticated;

grant execute on function public.persist_evidence_run_v1(jsonb)
  to authenticated, service_role;
grant execute on function public.apply_chunk_embeddings_v1(uuid, text, text, jsonb, boolean)
  to service_role;
grant execute on function public.execute_run_retrieval_v2(
  uuid, text, extensions.vector, text, text, integer, integer
) to authenticated, service_role;
grant execute on function public.hybrid_search_document_chunks(
  uuid, text, extensions.vector, uuid, integer, integer
) to service_role;

commit;

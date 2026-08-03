create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  objective text not null default '' check (char_length(objective) <= 2000),
  status text not null default 'active' check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (run_id, workspace_id) references public.runs(id, workspace_id) on delete cascade
);

create table public.campaign_candidates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  name text not null check (char_length(name) between 1 and 160),
  input_smiles text not null check (char_length(input_smiles) between 1 and 10000),
  canonical_smiles text,
  structure_hash text check (structure_hash is null or structure_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'ingested' check (status in ('ingested', 'queued', 'evaluating', 'evaluated', 'needs_review', 'advanced', 'held', 'rejected', 'failed')),
  rank_score double precision check (rank_score is null or rank_score between 0 and 100),
  rank_components jsonb not null default '{}'::jsonb check (jsonb_typeof(rank_components) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (id, run_id, workspace_id),
  foreign key (campaign_id, run_id, workspace_id) references public.campaigns(id, run_id, workspace_id) on delete cascade
);

create table public.candidate_evaluations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  job_id uuid,
  evaluation_type text not null check (evaluation_type in ('molecule_prep', 'admet', 'docking_prepare', 'docking_score', 'retrosynthesis_fragments', 'route_planning')),
  status text not null check (status in ('completed', 'blocked', 'failed')),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  applicability jsonb not null default '{}'::jsonb check (jsonb_typeof(applicability) = 'object'),
  score_component jsonb not null default '{}'::jsonb check (jsonb_typeof(score_component) = 'object'),
  boundary text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (candidate_id, run_id, workspace_id) references public.campaign_candidates(id, run_id, workspace_id) on delete cascade,
  foreign key (job_id, run_id, workspace_id) references public.jobs(id, run_id, workspace_id) on delete set null,
  unique (candidate_id, evaluation_type)
);

create table public.scientific_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('advance', 'hold', 'reject')),
  rationale text not null check (char_length(rationale) between 3 and 5000),
  evidence_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence_snapshot) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (candidate_id, run_id, workspace_id) references public.campaign_candidates(id, run_id, workspace_id) on delete cascade
);

create index campaigns_run_idx on public.campaigns (workspace_id, run_id, created_at desc);
create index campaign_candidates_rank_idx on public.campaign_candidates (campaign_id, rank_score desc nulls last, created_at);
create index candidate_evaluations_candidate_idx on public.candidate_evaluations (candidate_id, created_at);
create index scientific_reviews_candidate_idx on public.scientific_reviews (candidate_id, created_at desc);

create trigger campaigns_set_updated_at before update on public.campaigns
for each row execute function public.set_updated_at();
create trigger campaign_candidates_set_updated_at before update on public.campaign_candidates
for each row execute function public.set_updated_at();
create trigger candidate_evaluations_set_updated_at before update on public.candidate_evaluations
for each row execute function public.set_updated_at();

alter table public.campaigns enable row level security;
alter table public.campaign_candidates enable row level security;
alter table public.candidate_evaluations enable row level security;
alter table public.scientific_reviews enable row level security;

create policy campaigns_select_member on public.campaigns for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy campaign_candidates_select_member on public.campaign_candidates for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy candidate_evaluations_select_member on public.candidate_evaluations for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy scientific_reviews_select_member on public.scientific_reviews for select to authenticated
using (public.is_workspace_member(workspace_id));

create or replace function public.create_campaign_v1(
  p_run_id uuid,
  p_name text,
  p_objective text default '',
  p_settings jsonb default '{}'::jsonb
) returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_workspace uuid;
  v_result public.campaigns;
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  select r.workspace_id into v_workspace from public.runs r
  where r.id = p_run_id and public.can_write_workspace(r.workspace_id);
  if v_workspace is null then raise exception 'Evidence run is unavailable' using errcode = '42501'; end if;
  insert into public.campaigns (workspace_id, run_id, name, objective, settings, created_by)
  values (v_workspace, p_run_id, btrim(p_name), coalesce(p_objective, ''), coalesce(p_settings, '{}'::jsonb), v_user)
  returning * into v_result;
  return v_result;
end; $$;

create or replace function public.add_campaign_candidate_v1(
  p_campaign_id uuid,
  p_name text,
  p_smiles text
) returns public.campaign_candidates
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_campaign public.campaigns;
  v_result public.campaign_candidates;
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  select * into v_campaign from public.campaigns c
  where c.id = p_campaign_id and public.can_write_workspace(c.workspace_id);
  if v_campaign.id is null then raise exception 'Campaign is unavailable' using errcode = '42501'; end if;
  insert into public.campaign_candidates (campaign_id, workspace_id, run_id, name, input_smiles, created_by)
  values (v_campaign.id, v_campaign.workspace_id, v_campaign.run_id, btrim(p_name), btrim(p_smiles), v_user)
  returning * into v_result;
  return v_result;
end; $$;

create or replace function public.queue_candidate_workflow_v1(p_candidate_id uuid)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_candidate public.campaign_candidates;
  v_campaign public.campaigns;
  v_job_type text;
begin
  select * into v_candidate from public.campaign_candidates c
  where c.id = p_candidate_id and public.can_write_workspace(c.workspace_id);
  if v_candidate.id is null then raise exception 'Candidate is unavailable' using errcode = '42501'; end if;
  select * into v_campaign from public.campaigns where id = v_candidate.campaign_id;
  foreach v_job_type in array array['molecule_prep','admet','docking_prepare','docking_score','retrosynthesis_fragments','route_planning'] loop
    return query
    insert into public.jobs (workspace_id, run_id, job_type, status, priority, idempotency_key, payload)
    values (
      v_candidate.workspace_id,
      v_candidate.run_id,
      v_job_type,
      'queued',
      case v_job_type when 'molecule_prep' then 60 when 'admet' then 50 else 30 end,
      'candidate:' || v_candidate.id::text || ':' || v_job_type,
      jsonb_build_object(
        'campaignId', v_candidate.campaign_id,
        'candidateId', v_candidate.id,
        'smiles', v_candidate.input_smiles,
        'campaignSettings', v_campaign.settings
      )
    ) on conflict (workspace_id, idempotency_key) do update
      set status = case when public.jobs.status in ('failed','blocked','cancelled') then 'queued'::public.job_status else public.jobs.status end,
          error = null,
          updated_at = timezone('utc', now())
    returning public.jobs.*;
  end loop;
  update public.campaign_candidates set status = 'queued' where id = v_candidate.id;
end; $$;

create or replace function public.submit_scientific_review_v1(
  p_candidate_id uuid,
  p_decision text,
  p_rationale text
) returns public.scientific_reviews
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_candidate public.campaign_candidates;
  v_result public.scientific_reviews;
begin
  if p_decision not in ('advance','hold','reject') then raise exception 'Unsupported decision' using errcode = '22023'; end if;
  select * into v_candidate from public.campaign_candidates c
  where c.id = p_candidate_id and public.can_write_workspace(c.workspace_id);
  if v_candidate.id is null then raise exception 'Candidate is unavailable' using errcode = '42501'; end if;
  insert into public.scientific_reviews (candidate_id, workspace_id, run_id, reviewer_id, decision, rationale, evidence_snapshot)
  values (v_candidate.id, v_candidate.workspace_id, v_candidate.run_id, v_user, p_decision, btrim(p_rationale),
    jsonb_build_object('rankScore', v_candidate.rank_score, 'rankComponents', v_candidate.rank_components, 'capturedAt', timezone('utc', now())))
  returning * into v_result;
  update public.campaign_candidates set status = case p_decision when 'advance' then 'advanced' when 'hold' then 'held' else 'rejected' end
  where id = v_candidate.id;
  return v_result;
end; $$;

create or replace function public.lease_campaign_jobs_v1(p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 120)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  return query
  with selected as (
    select j.id from public.jobs j
    where (j.status = 'queued' or (j.status = 'leased' and j.lease_expires_at < timezone('utc', now())))
      and j.job_type in ('molecule_prep','admet','docking_prepare','docking_score','retrosynthesis_fragments','route_planning')
    order by j.priority desc, j.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 10))
  )
  update public.jobs j set status = 'leased', lease_owner = p_worker_id,
    lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(30, least(p_lease_seconds, 900))),
    heartbeat_at = timezone('utc', now()), attempts = attempts + 1, updated_at = timezone('utc', now())
  from selected where j.id = selected.id returning j.*;
end; $$;

create or replace function public.complete_campaign_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_status public.job_status,
  p_result jsonb,
  p_error jsonb,
  p_applicability jsonb,
  p_score_component jsonb,
  p_boundary text
) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_candidate_id uuid;
  v_eval_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if v_job.id is null or v_job.lease_owner is distinct from p_worker_id then raise exception 'Job lease is unavailable' using errcode = '42501'; end if;
  v_candidate_id := public.try_uuid(v_job.payload ->> 'candidateId');
  v_eval_status := case p_status when 'succeeded' then 'completed' when 'blocked' then 'blocked' else 'failed' end;
  update public.jobs set status = p_status, result = p_result, error = p_error,
    lease_owner = null, lease_expires_at = null, heartbeat_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where id = v_job.id returning * into v_job;
  insert into public.candidate_evaluations (candidate_id, workspace_id, run_id, job_id, evaluation_type, status, result, applicability, score_component, boundary)
  values (v_candidate_id, v_job.workspace_id, v_job.run_id, v_job.id, v_job.job_type, v_eval_status,
    coalesce(p_result, '{}'::jsonb), coalesce(p_applicability, '{}'::jsonb), coalesce(p_score_component, '{}'::jsonb), coalesce(p_boundary, 'No scientific boundary was reported.'))
  on conflict (candidate_id, evaluation_type) do update set
    job_id = excluded.job_id, status = excluded.status, result = excluded.result,
    applicability = excluded.applicability, score_component = excluded.score_component,
    boundary = excluded.boundary, updated_at = timezone('utc', now());
  update public.campaign_candidates c set
    canonical_smiles = coalesce((select e.result ->> 'canonicalSmiles' from public.candidate_evaluations e where e.candidate_id = c.id and e.evaluation_type = 'molecule_prep'), c.canonical_smiles),
    structure_hash = coalesce((select e.result ->> 'structureHash' from public.candidate_evaluations e where e.candidate_id = c.id and e.evaluation_type = 'molecule_prep'), c.structure_hash),
    rank_score = (select case when count(*) filter (where (e.score_component ->> 'eligible')::boolean) = 0 then null else
      round((sum(coalesce((e.score_component ->> 'points')::double precision, 0)) filter (where (e.score_component ->> 'eligible')::boolean)
        / nullif(sum(coalesce((e.score_component ->> 'maxPoints')::double precision, 0)) filter (where (e.score_component ->> 'eligible')::boolean), 0) * 100)::numeric, 2)::double precision end
      from public.candidate_evaluations e where e.candidate_id = c.id),
    rank_components = (select coalesce(jsonb_object_agg(e.evaluation_type, e.score_component), '{}'::jsonb) from public.candidate_evaluations e where e.candidate_id = c.id),
    status = case when exists (select 1 from public.jobs j where public.try_uuid(j.payload ->> 'candidateId') = c.id and j.status in ('queued','leased','running')) then 'evaluating' else 'needs_review' end
  where c.id = v_candidate_id;
  return v_job;
end; $$;

revoke all on public.campaigns, public.campaign_candidates, public.candidate_evaluations, public.scientific_reviews from anon;
grant select on public.campaigns, public.campaign_candidates, public.candidate_evaluations, public.scientific_reviews to authenticated;
grant all on public.campaigns, public.campaign_candidates, public.candidate_evaluations, public.scientific_reviews to service_role;
revoke all on function public.create_campaign_v1(uuid,text,text,jsonb), public.add_campaign_candidate_v1(uuid,text,text),
  public.queue_candidate_workflow_v1(uuid), public.submit_scientific_review_v1(uuid,text,text),
  public.lease_campaign_jobs_v1(text,integer,integer),
  public.complete_campaign_job_v1(uuid,text,public.job_status,jsonb,jsonb,jsonb,jsonb,text) from public, anon;
grant execute on function public.create_campaign_v1(uuid,text,text,jsonb), public.add_campaign_candidate_v1(uuid,text,text),
  public.queue_candidate_workflow_v1(uuid), public.submit_scientific_review_v1(uuid,text,text) to authenticated, service_role;
grant execute on function public.lease_campaign_jobs_v1(text,integer,integer),
  public.complete_campaign_job_v1(uuid,text,public.job_status,jsonb,jsonb,jsonb,jsonb,text) to service_role;

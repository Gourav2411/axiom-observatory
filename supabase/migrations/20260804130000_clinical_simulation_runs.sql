create table public.clinical_simulation_runs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  job_id uuid,
  phase text not null check (phase in ('phase1', 'phase2')),
  mode text not null check (mode in ('research_scenario', 'evidence_qualified')),
  scenario jsonb not null check (jsonb_typeof(scenario) = 'object'),
  scenario_sha256 text not null check (scenario_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  model_version text not null default 'axiom-open-pkpd-rk4.1',
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  error jsonb,
  boundary text not null default 'No clinical simulation has executed.',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  unique (id, run_id, workspace_id),
  foreign key (candidate_id, run_id, workspace_id) references public.campaign_candidates(id, run_id, workspace_id) on delete cascade,
  foreign key (job_id, run_id, workspace_id) references public.jobs(id, run_id, workspace_id) on delete set null
);

create index clinical_simulation_runs_candidate_idx
on public.clinical_simulation_runs (candidate_id, phase, created_at desc);

create trigger clinical_simulation_runs_set_updated_at before update on public.clinical_simulation_runs
for each row execute function public.set_updated_at();

alter table public.clinical_simulation_runs enable row level security;
create policy clinical_simulation_runs_select_member on public.clinical_simulation_runs for select to authenticated
using (public.is_workspace_member(workspace_id));

create or replace function public.queue_clinical_simulation_v1(
  p_candidate_id uuid,
  p_phase text,
  p_mode text,
  p_scenario jsonb
) returns public.clinical_simulation_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_candidate public.campaign_candidates;
  v_simulation public.clinical_simulation_runs;
  v_job public.jobs;
  v_required integer;
  v_qualified integer;
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if p_phase not in ('phase1','phase2') or p_mode not in ('research_scenario','evidence_qualified')
    or p_scenario is null or jsonb_typeof(p_scenario) <> 'object'
  then raise exception 'A valid phase, execution mode and scenario are required' using errcode = '22023'; end if;

  select * into v_candidate from public.campaign_candidates c
  where c.id = p_candidate_id and public.can_write_workspace(c.workspace_id);
  if v_candidate.id is null then raise exception 'Candidate is unavailable' using errcode = '42501'; end if;

  if p_mode = 'evidence_qualified' then
    v_required := case p_phase when 'phase1' then 6 else 11 end;
    select count(distinct (i.phase, i.domain)) into v_qualified
    from public.clinical_translation_inputs i
    where i.candidate_id = v_candidate.id and i.review_status = 'qualified'
      and (i.phase = 'phase1' or (p_phase = 'phase2' and i.phase = 'phase2'));
    if v_qualified < v_required then
      raise exception 'Evidence-qualified execution requires every phase prerequisite to be qualified' using errcode = '22023';
    end if;
  end if;

  insert into public.clinical_simulation_runs (
    candidate_id, workspace_id, run_id, phase, mode, scenario, scenario_sha256, created_by
  ) values (
    v_candidate.id, v_candidate.workspace_id, v_candidate.run_id, p_phase, p_mode, p_scenario,
    encode(extensions.digest(convert_to(p_scenario::text, 'UTF8'), 'sha256'), 'hex'), v_user
  ) returning * into v_simulation;

  insert into public.jobs (workspace_id, run_id, job_type, status, priority, idempotency_key, payload)
  values (
    v_candidate.workspace_id,
    v_candidate.run_id,
    case p_phase when 'phase1' then 'clinical_phase1_simulation' else 'clinical_phase2_simulation' end,
    'queued',
    45,
    'clinical-simulation:' || v_simulation.id::text,
    jsonb_build_object(
      'campaignId', v_candidate.campaign_id,
      'candidateId', v_candidate.id,
      'simulationId', v_simulation.id,
      'phase', p_phase,
      'mode', p_mode,
      'scenario', p_scenario
    )
  ) returning * into v_job;

  update public.clinical_simulation_runs set job_id = v_job.id where id = v_simulation.id
  returning * into v_simulation;
  return v_simulation;
end; $$;

create or replace function public.complete_clinical_simulation_v1(
  p_job_id uuid,
  p_worker_id text,
  p_status public.job_status,
  p_result jsonb,
  p_error jsonb,
  p_boundary text
) returns public.clinical_simulation_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_simulation public.clinical_simulation_runs;
  v_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  if p_status not in ('succeeded','failed','cancelled') then raise exception 'Unsupported terminal status' using errcode = '22023'; end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if v_job.id is null or v_job.lease_owner is distinct from p_worker_id
    or v_job.job_type not in ('clinical_phase1_simulation','clinical_phase2_simulation')
  then raise exception 'Clinical simulation job lease is unavailable' using errcode = '42501'; end if;

  v_status := p_status::text;
  update public.jobs set status = p_status, result = coalesce(p_result, '{}'::jsonb), error = p_error,
    lease_owner = null, lease_expires_at = null, heartbeat_at = timezone('utc', now()), updated_at = timezone('utc', now())
  where id = v_job.id;

  update public.clinical_simulation_runs set
    status = v_status,
    result = coalesce(p_result, '{}'::jsonb),
    error = p_error,
    boundary = coalesce(nullif(btrim(p_boundary), ''), 'The simulation worker did not report a scientific boundary.'),
    completed_at = case when p_status in ('succeeded','failed','cancelled') then timezone('utc', now()) else null end
  where job_id = v_job.id returning * into v_simulation;
  if v_simulation.id is null then raise exception 'Clinical simulation record is unavailable' using errcode = 'P0002'; end if;
  return v_simulation;
end; $$;

revoke all on public.clinical_simulation_runs from anon;
grant select on public.clinical_simulation_runs to authenticated;
grant all on public.clinical_simulation_runs to service_role;
revoke all on function public.queue_clinical_simulation_v1(uuid,text,text,jsonb) from public, anon;
revoke all on function public.complete_clinical_simulation_v1(uuid,text,public.job_status,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.queue_clinical_simulation_v1(uuid,text,text,jsonb) to authenticated, service_role;
grant execute on function public.complete_clinical_simulation_v1(uuid,text,public.job_status,jsonb,jsonb,text) to service_role;

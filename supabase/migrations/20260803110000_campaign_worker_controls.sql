alter type public.job_status add value if not exists 'blocked';

create or replace function public.heartbeat_campaign_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 600
) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  update public.jobs set
    heartbeat_at = timezone('utc', now()),
    lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(30, least(p_lease_seconds, 900))),
    updated_at = timezone('utc', now())
  where id = p_job_id and lease_owner = p_worker_id and status in ('leased', 'running')
  returning * into v_job;
  if v_job.id is null then raise exception 'Job lease is unavailable' using errcode = '42501'; end if;
  return v_job;
end; $$;

create or replace function public.lease_campaign_jobs_v1(p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 120)
returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  update public.jobs set status = 'failed', error = jsonb_build_object(
    'code', 'attempt_budget_exhausted',
    'message', 'The job exhausted its configured attempt budget.'
  ), updated_at = timezone('utc', now())
  where status in ('queued','leased') and attempts >= max_attempts
    and (status = 'queued' or lease_expires_at < timezone('utc', now()));
  return query
  with selected as (
    select j.id from public.jobs j
    where (j.status = 'queued' or (j.status = 'leased' and j.lease_expires_at < timezone('utc', now())))
      and j.attempts < j.max_attempts
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

revoke all on function public.heartbeat_campaign_job_v1(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.heartbeat_campaign_job_v1(uuid,text,integer) to service_role;

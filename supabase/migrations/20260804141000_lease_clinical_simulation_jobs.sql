create or replace function public.lease_campaign_jobs_v2(
  p_worker_id text,
  p_job_types text[],
  p_limit integer default 1,
  p_lease_seconds integer default 120
) returns setof public.jobs
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required' using errcode = '42501'; end if;
  if coalesce(array_length(p_job_types, 1), 0) = 0 then raise exception 'At least one job type is required' using errcode = '22023'; end if;
  if exists (
    select 1 from unnest(p_job_types) as requested(job_type)
    where requested.job_type not in (
      'molecule_prep',
      'admet',
      'docking_prepare',
      'docking_score',
      'retrosynthesis_fragments',
      'route_planning',
      'clinical_phase1_simulation',
      'clinical_phase2_simulation'
    )
  ) then
    raise exception 'Unsupported campaign job type' using errcode = '22023';
  end if;

  update public.jobs set status = 'failed', error = jsonb_build_object(
    'code', 'attempt_budget_exhausted',
    'message', 'The job exhausted its configured attempt budget.'
  ), updated_at = timezone('utc', now())
  where status in ('queued','leased') and attempts >= max_attempts
    and job_type = any(p_job_types)
    and (status = 'queued' or lease_expires_at < timezone('utc', now()));

  return query
  with selected as (
    select j.id from public.jobs j
    where (j.status = 'queued' or (j.status = 'leased' and j.lease_expires_at < timezone('utc', now())))
      and j.attempts < j.max_attempts
      and j.job_type = any(p_job_types)
    order by j.priority desc, j.created_at
    for update skip locked
    limit greatest(1, least(p_limit, 10))
  )
  update public.jobs j set status = 'leased', lease_owner = p_worker_id,
    lease_expires_at = timezone('utc', now()) + make_interval(secs => greatest(30, least(p_lease_seconds, 900))),
    heartbeat_at = timezone('utc', now()), attempts = attempts + 1, updated_at = timezone('utc', now())
  from selected where j.id = selected.id returning j.*;
end; $$;

revoke all on function public.lease_campaign_jobs_v2(text,text[],integer,integer) from public, anon, authenticated;
grant execute on function public.lease_campaign_jobs_v2(text,text[],integer,integer) to service_role;

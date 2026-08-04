create or replace function public.queue_validation_admet_v1(
  p_run_id uuid,
  p_smiles text,
  p_name text default 'Validation workbench candidate'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_run public.runs;
  v_campaign public.campaigns;
  v_candidate public.campaign_candidates;
  v_job public.jobs;
begin
  if v_user is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_smiles is null or char_length(btrim(p_smiles)) not between 1 and 10000 then
    raise exception 'A valid SMILES structure is required' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 160 then
    raise exception 'A candidate name between 1 and 160 characters is required' using errcode = '22023';
  end if;

  select * into v_run
  from public.runs r
  where r.id = p_run_id and public.can_write_workspace(r.workspace_id);
  if v_run.id is null then
    raise exception 'Run is unavailable' using errcode = '42501';
  end if;

  select * into v_campaign
  from public.campaigns c
  where c.run_id = v_run.id
    and c.workspace_id = v_run.workspace_id
    and c.settings ->> 'source' = 'validation_workbench'
  order by c.created_at asc
  limit 1;

  if v_campaign.id is null then
    insert into public.campaigns (
      workspace_id, run_id, name, objective, settings, created_by
    ) values (
      v_run.workspace_id,
      v_run.id,
      'Validation workbench',
      'Asynchronous model inference requested from the validation workbench',
      jsonb_build_object('source', 'validation_workbench'),
      v_user
    ) returning * into v_campaign;
  end if;

  select * into v_candidate
  from public.campaign_candidates c
  where c.campaign_id = v_campaign.id
    and c.workspace_id = v_run.workspace_id
    and c.input_smiles = btrim(p_smiles)
  order by c.created_at asc
  limit 1;

  if v_candidate.id is null then
    insert into public.campaign_candidates (
      campaign_id, workspace_id, run_id, name, input_smiles, status, created_by
    ) values (
      v_campaign.id,
      v_run.workspace_id,
      v_run.id,
      btrim(p_name),
      btrim(p_smiles),
      'queued',
      v_user
    ) returning * into v_candidate;
  else
    update public.campaign_candidates
    set name = btrim(p_name), status = 'queued', updated_at = timezone('utc', now())
    where id = v_candidate.id
    returning * into v_candidate;
  end if;

  insert into public.jobs (
    workspace_id, run_id, job_type, status, priority, attempts, max_attempts,
    idempotency_key, payload
  ) values (
    v_run.workspace_id,
    v_run.id,
    'admet',
    'queued',
    70,
    0,
    3,
    'validation-admet:' || v_candidate.id::text,
    jsonb_build_object(
      'campaignId', v_campaign.id,
      'candidateId', v_candidate.id,
      'smiles', v_candidate.input_smiles,
      'campaignSettings', v_campaign.settings,
      'requestedFrom', 'validation_workbench'
    )
  ) on conflict (workspace_id, idempotency_key) do update
    set status = case
          when public.jobs.status in ('leased', 'running') then public.jobs.status
          else 'queued'::public.job_status
        end,
        attempts = case
          when public.jobs.status in ('leased', 'running') then public.jobs.attempts
          else 0
        end,
        error = case
          when public.jobs.status in ('leased', 'running') then public.jobs.error
          else null
        end,
        lease_owner = case
          when public.jobs.status in ('leased', 'running') then public.jobs.lease_owner
          else null
        end,
        lease_expires_at = case
          when public.jobs.status in ('leased', 'running') then public.jobs.lease_expires_at
          else null
        end,
        heartbeat_at = case
          when public.jobs.status in ('leased', 'running') then public.jobs.heartbeat_at
          else null
        end,
        payload = excluded.payload,
        updated_at = timezone('utc', now())
  returning * into v_job;

  return jsonb_build_object(
    'campaignId', v_campaign.id,
    'candidateId', v_candidate.id,
    'job', to_jsonb(v_job)
  );
end;
$$;

revoke all on function public.queue_validation_admet_v1(uuid, text, text) from public, anon;
grant execute on function public.queue_validation_admet_v1(uuid, text, text) to authenticated;

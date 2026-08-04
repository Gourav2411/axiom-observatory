create or replace function public.prepare_receptor_upload_v1(
  p_run_id uuid,
  p_receptor_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_receptor_id is null
    or char_length(btrim(p_receptor_id)) not between 1 and 80
    or btrim(p_receptor_id) !~ '^[A-Za-z0-9_.-]+$' then
    raise exception 'A safe receptor identifier is required' using errcode = '22023';
  end if;

  select * into v_run
  from public.runs r
  where r.id = p_run_id and public.can_write_workspace(r.workspace_id);
  if v_run.id is null then
    raise exception 'Run is unavailable' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'runId', v_run.id,
    'workspaceId', v_run.workspace_id,
    'receptorId', btrim(p_receptor_id)
  );
end;
$$;

revoke all on function public.prepare_receptor_upload_v1(uuid, text) from public, anon;
grant execute on function public.prepare_receptor_upload_v1(uuid, text) to authenticated;

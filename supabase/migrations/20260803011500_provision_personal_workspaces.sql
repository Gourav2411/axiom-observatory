-- Provision the tenant boundary at account creation and repair accounts that
-- predate automatic workspace provisioning.

create or replace function public.provision_personal_workspace_for_user(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  personal_slug text;
  resolved_workspace_id uuid;
begin
  if p_user_id is null then
    raise exception 'A user identifier is required';
  end if;

  personal_slug := 'personal-' || replace(p_user_id::text, '-', '');

  insert into public.workspaces (name, slug, created_by)
  values ('Personal workspace', personal_slug, p_user_id)
  on conflict (slug) do nothing;

  select w.id into resolved_workspace_id
  from public.workspaces w
  where w.slug = personal_slug
    and w.created_by = p_user_id;

  if resolved_workspace_id is null then
    raise exception 'The reserved personal workspace slug is unavailable';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (resolved_workspace_id, p_user_id, 'owner', p_user_id)
  on conflict (workspace_id, user_id) do update
    set role = 'owner';

  return resolved_workspace_id;
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
begin
  if caller_id is null then
    raise exception 'Authentication is required';
  end if;
  return public.provision_personal_workspace_for_user(caller_id);
end;
$$;

create or replace function public.handle_new_auth_user_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.provision_personal_workspace_for_user(new.id);
  return new;
end;
$$;

drop trigger if exists auth_user_provision_personal_workspace on auth.users;
create trigger auth_user_provision_personal_workspace
after insert on auth.users
for each row execute function public.handle_new_auth_user_workspace();

do $$
declare
  existing_user record;
begin
  for existing_user in select id from auth.users loop
    perform public.provision_personal_workspace_for_user(existing_user.id);
  end loop;
end;
$$;

revoke all on function public.provision_personal_workspace_for_user(uuid) from public, anon, authenticated;
revoke all on function public.handle_new_auth_user_workspace() from public, anon, authenticated;
grant execute on function public.provision_personal_workspace_for_user(uuid) to service_role;
grant execute on function public.ensure_default_workspace() to authenticated, service_role;

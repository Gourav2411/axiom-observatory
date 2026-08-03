create table public.assay_results (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  source_type text not null check (source_type in ('experimental', 'external_report')),
  assay_type text not null check (char_length(assay_type) between 2 and 120),
  endpoint text not null check (char_length(endpoint) between 1 and 160),
  value double precision not null check (value > '-Infinity'::double precision and value < 'Infinity'::double precision),
  qualifier text not null default '=' check (qualifier in ('=', '<', '<=', '>', '>=')),
  unit text not null check (char_length(unit) between 1 and 40),
  replicate integer check (replicate is null or replicate > 0),
  control_type text not null default 'none' check (control_type in ('none', 'vehicle', 'positive', 'negative', 'reference')),
  qc_status text not null default 'not_assessed' check (qc_status in ('not_assessed', 'pending', 'pass', 'fail')),
  protocol jsonb not null default '{}'::jsonb check (jsonb_typeof(protocol) = 'object'),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (candidate_id, run_id, workspace_id) references public.campaign_candidates(id, run_id, workspace_id) on delete cascade
);

create index assay_results_candidate_idx on public.assay_results (candidate_id, created_at desc);
create index assay_results_run_idx on public.assay_results (workspace_id, run_id, created_at desc);

alter table public.assay_results enable row level security;
create policy assay_results_select_member on public.assay_results for select to authenticated
using (public.is_workspace_member(workspace_id));

create or replace function public.ingest_assay_result_v1(
  p_candidate_id uuid,
  p_input jsonb
) returns public.assay_results
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_candidate public.campaign_candidates;
  v_result public.assay_results;
  v_provenance jsonb := coalesce(p_input -> 'provenance', '{}'::jsonb);
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_input, 'null'::jsonb)) <> 'object' then raise exception 'Assay input must be an object' using errcode = '22023'; end if;
  if jsonb_typeof(p_input -> 'value') <> 'number' then raise exception 'Assay value must be numeric' using errcode = '22023'; end if;
  if nullif(btrim(v_provenance ->> 'sourceReference'), '') is null then
    raise exception 'A provenance sourceReference is required' using errcode = '22023';
  end if;
  select * into v_candidate from public.campaign_candidates c
  where c.id = p_candidate_id and public.can_write_workspace(c.workspace_id);
  if v_candidate.id is null then raise exception 'Candidate is unavailable' using errcode = '42501'; end if;
  insert into public.assay_results (
    candidate_id, workspace_id, run_id, source_type, assay_type, endpoint, value,
    qualifier, unit, replicate, control_type, qc_status, protocol, provenance, created_by
  ) values (
    v_candidate.id, v_candidate.workspace_id, v_candidate.run_id,
    coalesce(nullif(p_input ->> 'sourceType', ''), 'experimental'),
    btrim(p_input ->> 'assayType'), btrim(p_input ->> 'endpoint'), (p_input ->> 'value')::double precision,
    coalesce(nullif(p_input ->> 'qualifier', ''), '='), btrim(p_input ->> 'unit'),
    nullif(p_input ->> 'replicate', '')::integer,
    coalesce(nullif(p_input ->> 'controlType', ''), 'none'),
    coalesce(nullif(p_input ->> 'qcStatus', ''), 'not_assessed'),
    coalesce(p_input -> 'protocol', '{}'::jsonb), v_provenance, v_user
  ) returning * into v_result;
  return v_result;
end; $$;

revoke all on table public.assay_results from anon;
grant select on table public.assay_results to authenticated;
revoke all on function public.ingest_assay_result_v1(uuid,jsonb) from public, anon;
grant execute on function public.ingest_assay_result_v1(uuid,jsonb) to authenticated;

create table public.clinical_translation_inputs (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null,
  phase text not null check (phase in ('phase1', 'phase2')),
  domain text not null check (domain in (
    'identity', 'formulation', 'inVitroAdme', 'animalPk', 'toxicology', 'exposureBasis',
    'humanPk', 'humanSafety', 'pdBiomarker', 'diseaseModel', 'endpointModel'
  )),
  input_kind text not null check (input_kind in ('document', 'measurement', 'model', 'observation')),
  source_reference text not null check (char_length(source_reference) between 2 and 500),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  review_status text not null default 'pending' check (review_status in ('pending', 'qualified', 'rejected')),
  review_rationale text,
  created_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (candidate_id, run_id, workspace_id) references public.campaign_candidates(id, run_id, workspace_id) on delete cascade,
  check ((phase = 'phase1' and domain in ('identity','formulation','inVitroAdme','animalPk','toxicology','exposureBasis'))
    or (phase = 'phase2' and domain in ('humanPk','humanSafety','pdBiomarker','diseaseModel','endpointModel'))),
  check ((review_status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (review_status in ('qualified','rejected') and reviewed_by is not null and reviewed_at is not null and char_length(review_rationale) >= 3))
);

create index clinical_translation_inputs_candidate_idx
on public.clinical_translation_inputs (candidate_id, phase, domain, created_at desc);

alter table public.clinical_translation_inputs enable row level security;
create policy clinical_translation_inputs_select_member on public.clinical_translation_inputs for select to authenticated
using (public.is_workspace_member(workspace_id));

create or replace function public.register_clinical_translation_input_v1(
  p_candidate_id uuid,
  p_phase text,
  p_domain text,
  p_input_kind text,
  p_source_reference text,
  p_payload jsonb default '{}'::jsonb
) returns public.clinical_translation_inputs
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_candidate public.campaign_candidates;
  v_result public.clinical_translation_inputs;
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  select * into v_candidate from public.campaign_candidates c
  where c.id = p_candidate_id and public.can_write_workspace(c.workspace_id);
  if v_candidate.id is null then raise exception 'Candidate is unavailable' using errcode = '42501'; end if;
  insert into public.clinical_translation_inputs (
    candidate_id, workspace_id, run_id, phase, domain, input_kind, source_reference, payload, created_by
  ) values (
    v_candidate.id, v_candidate.workspace_id, v_candidate.run_id, p_phase, p_domain,
    p_input_kind, btrim(p_source_reference), coalesce(p_payload, '{}'::jsonb), v_user
  ) returning * into v_result;
  return v_result;
end; $$;

create or replace function public.review_clinical_translation_input_v1(
  p_input_id uuid,
  p_decision text,
  p_rationale text
) returns public.clinical_translation_inputs
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_result public.clinical_translation_inputs;
begin
  if v_user is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if p_decision not in ('qualified','rejected') then raise exception 'Unsupported review decision' using errcode = '22023'; end if;
  update public.clinical_translation_inputs i set
    review_status = p_decision,
    review_rationale = btrim(p_rationale),
    reviewed_by = v_user,
    reviewed_at = timezone('utc', now())
  where i.id = p_input_id and public.can_write_workspace(i.workspace_id)
  returning * into v_result;
  if v_result.id is null then raise exception 'Translation input is unavailable' using errcode = '42501'; end if;
  return v_result;
end; $$;

revoke all on table public.clinical_translation_inputs from anon;
grant select on table public.clinical_translation_inputs to authenticated;
revoke all on function public.register_clinical_translation_input_v1(uuid,text,text,text,text,jsonb) from public, anon;
revoke all on function public.review_clinical_translation_input_v1(uuid,text,text) from public, anon;
grant execute on function public.register_clinical_translation_input_v1(uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function public.review_clinical_translation_input_v1(uuid,text,text) to authenticated;

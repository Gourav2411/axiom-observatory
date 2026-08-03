const PHASE_ONE_DOMAINS = [
  ["identity", "Candidate identity and salt/form are fixed"],
  ["formulation", "Clinical formulation and route are defined"],
  ["inVitroAdme", "In-vitro ADME and disposition inputs are measured"],
  ["animalPk", "Qualified animal PK data are available"],
  ["toxicology", "GLP toxicology exposure and NOAEL data are available"],
  ["exposureBasis", "MABEL or pharmacologically active exposure basis is documented"],
];

const PHASE_TWO_DOMAINS = [
  ["humanPk", "Phase I human PK and variability are available"],
  ["humanSafety", "Phase I safety and tolerability data are available"],
  ["pdBiomarker", "A qualified PD or biomarker model is available"],
  ["diseaseModel", "Disease natural-history or progression inputs are available"],
  ["endpointModel", "Endpoint, placebo, effect-size and dropout assumptions are sourced"],
];

function domainStatus(key, label, inputs, assays) {
  const declaration = inputs?.[key];
  const supportingAssays = assays.filter((assay) => assay.provenance?.readinessDomain === key && assay.qc_status === "pass");
  const complete = Boolean(declaration?.sourceReference) && supportingAssays.length > 0;
  return {
    key,
    label,
    status: complete ? "evidence_supplied" : "missing_qualified_input",
    sourceReference: declaration?.sourceReference || null,
    supportingAssayIds: supportingAssays.map((assay) => assay.id),
  };
}

function assessClinicalReadiness(candidate, assays = [], inputs = {}) {
  const phase1 = PHASE_ONE_DOMAINS.map(([key, label]) => domainStatus(key, label, inputs.phase1, assays));
  const phase2 = PHASE_TWO_DOMAINS.map(([key, label]) => domainStatus(key, label, inputs.phase2, assays));
  const phase1Ready = phase1.every((item) => item.status === "evidence_supplied");
  const phase2Ready = phase1Ready && phase2.every((item) => item.status === "evidence_supplied");
  return {
    schemaVersion: "axiom-clinical-readiness.v1",
    candidateId: candidate.id,
    phase1: {
      status: phase1Ready ? "ready_for_pbpk_model_configuration" : "blocked_missing_qualified_inputs",
      domains: phase1,
    },
    phase2: {
      status: phase2Ready ? "ready_for_trial_model_configuration" : "blocked_missing_qualified_inputs",
      domains: phase2,
    },
    boundary: "This is a prerequisite and provenance audit. It does not simulate exposure, safety, efficacy, dose selection, or a clinical trial.",
  };
}

export { assessClinicalReadiness };

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

function domainStatus(phase, key, label, inputs, assays) {
  const qualifiedInputs = inputs.filter((input) => input.phase === phase && input.domain === key && input.review_status === "qualified");
  const supportingAssays = assays.filter((assay) => assay.provenance?.readinessDomain === key && assay.qc_status === "pass");
  return {
    key,
    label,
    status: qualifiedInputs.length ? "evidence_supplied" : "missing_qualified_input",
    qualifiedInputIds: qualifiedInputs.map((input) => input.id),
    sourceReferences: qualifiedInputs.map((input) => input.source_reference),
    supportingAssayIds: supportingAssays.map((assay) => assay.id),
  };
}

function assessClinicalReadiness(candidate, assays = [], inputs = [], engines = {}) {
  const phase1 = PHASE_ONE_DOMAINS.map(([key, label]) => domainStatus("phase1", key, label, inputs, assays));
  const phase2 = PHASE_TWO_DOMAINS.map(([key, label]) => domainStatus("phase2", key, label, inputs, assays));
  const phase1Ready = phase1.every((item) => item.status === "evidence_supplied");
  const phase2Ready = phase1Ready && phase2.every((item) => item.status === "evidence_supplied");
  const phase1EngineReady = Boolean(engines.pbpk && engines.poppk);
  const phase2EngineReady = Boolean(engines.trialSimulation);
  return {
    schemaVersion: "axiom-clinical-readiness.v1",
    candidateId: candidate.id,
    phase1: {
      status: phase1Ready ? "ready_for_pbpk_model_configuration" : "blocked_missing_qualified_inputs",
      executionStatus: phase1Ready && phase1EngineReady ? "ready_for_engine_execution" : phase1Ready ? "blocked_missing_simulation_engines" : "blocked_missing_qualified_inputs",
      engines: [
        { id: "pk-sim-mobi", label: "PK-Sim / MoBi PBPK", configured: Boolean(engines.pbpk) },
        { id: "nlmixr2-rxode2", label: "nlmixr2 / rxode2 population PK/PD", configured: Boolean(engines.poppk) },
      ],
      domains: phase1,
    },
    phase2: {
      status: phase2Ready ? "ready_for_trial_model_configuration" : "blocked_missing_qualified_inputs",
      executionStatus: phase2Ready && phase2EngineReady ? "ready_for_engine_execution" : phase2Ready ? "blocked_missing_simulation_engines" : "blocked_missing_qualified_inputs",
      engines: [{ id: "trial-simulation", label: "Validated Phase II statistical simulation worker", configured: Boolean(engines.trialSimulation) }],
      domains: phase2,
    },
    boundary: "This is a prerequisite and provenance audit. It does not simulate exposure, safety, efficacy, dose selection, or a clinical trial.",
  };
}

export { assessClinicalReadiness };

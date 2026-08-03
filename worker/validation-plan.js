const VALIDATION_WORKERS = Object.freeze([
  {
    id: "molecule_prep",
    label: "Molecule preparation",
    envKey: "AXIOM_RDKIT_WORKER_URL",
    toolchain: ["RDKit"],
    kind: "structure_standardization",
    outputBoundary: "Molecule preparation standardizes and validates chemical structure inputs; it does not predict activity, safety, binding, or synthesizability.",
    requiredInputs: [
      "Candidate molecule as SMILES, SDF, MOL, or MOL2",
      "Salt stripping and largest-fragment policy",
      "Tautomer, stereochemistry, charge, and protonation policy",
      "Canonicalization and invalid-structure rejection policy",
      "Structure hash and provenance metadata",
    ],
    expectedArtifacts: [
      "input_structure.json",
      "standardized_molecule.json",
      "canonical_smiles.txt",
      "structure_warnings.json",
      "worker_provenance.json",
    ],
  },
  {
    id: "docking",
    label: "Docking validation",
    envKey: "AXIOM_DOCKING_WORKER_URL",
    toolchain: ["RDKit", "Open Babel", "AutoDock Vina or Smina"],
    kind: "physics_informed_computation",
    outputBoundary: "Binding poses and docking scores are computational prioritization signals, not experimental binding validation.",
    requiredInputs: [
      "Prepared ligand structure from the RDKit molecule-prep worker",
      "Prepared receptor structure from PDB or AlphaFold",
      "Binding pocket definition and grid box",
      "Protonation, tautomer, stereochemistry, and charge state policy",
      "Positive or known-ligand redocking control when available",
    ],
    expectedArtifacts: [
      "prepared_ligand.sdf",
      "prepared_receptor.pdbqt",
      "dock_config.json",
      "poses.sdf",
      "scores.json",
      "worker_provenance.json",
    ],
  },
  {
    id: "admet",
    label: "ADMET and toxicity",
    envKey: "AXIOM_ADMET_WORKER_URL",
    toolchain: ["RDKit", "ADMET-AI", "DeepChem or Chemprop"],
    kind: "qsar_prediction",
    outputBoundary: "ADMET and toxicity outputs are model predictions from structure and training data, not measured safety results.",
    requiredInputs: [
      "Canonical molecule SMILES",
      "Salt stripping and standardization policy",
      "Assay endpoint list such as hERG, Ames, DILI, clearance, solubility, and permeability",
      "Model version and applicability-domain method",
      "Training-data provenance for each endpoint where available",
    ],
    expectedArtifacts: [
      "standardized_molecule.json",
      "endpoint_predictions.json",
      "applicability_domain.json",
      "toxicity_flags.json",
      "worker_provenance.json",
    ],
  },
  {
    id: "retrosynthesis",
    label: "Retrosynthesis",
    envKey: "AXIOM_RETROSYNTHESIS_WORKER_URL",
    toolchain: ["RDKit", "AiZynthFinder", "reaction-template library", "stock database"],
    kind: "template_route_search",
    outputBoundary: "Retrosynthesis proposes plausible routes from templates and stock data; it does not prove a reaction will work in the lab.",
    requiredInputs: [
      "Product molecule as canonical SMILES",
      "Template policy and model/checkpoint version",
      "Available building-block stock database",
      "Route depth, branching, and timeout limits",
      "Route scoring policy and failed-search reporting",
    ],
    expectedArtifacts: [
      "product_standardization.json",
      "route_tree.json",
      "stock_matches.json",
      "reaction_templates.json",
      "worker_provenance.json",
    ],
  },
]);

function configuredWorker(env, worker) {
  const endpoint = typeof env?.[worker.envKey] === "string" ? env[worker.envKey].trim() : "";
  const batchCompute = env?.AXIOM_HEAVY_COMPUTE_MODE === "github_actions" && ["admet", "docking"].includes(worker.id);
  return {
    id: worker.id,
    label: worker.label,
    status: batchCompute ? "queued_compute_configured" : endpoint ? "configured_not_executed" : "not_configured",
    configured: batchCompute || Boolean(endpoint),
    available: false,
    batchAvailable: batchCompute,
    execution: batchCompute ? "asynchronous_batched" : "request_response",
    openSource: true,
    toolchain: worker.toolchain,
    kind: worker.kind,
    endpointConfigured: Boolean(endpoint),
    requiredInputs: worker.requiredInputs,
    expectedArtifacts: worker.expectedArtifacts,
    outputBoundary: worker.outputBoundary,
    reason: batchCompute
      ? `${worker.label} executes asynchronously on GitHub-hosted runners after a campaign job is queued; availability is reported per job and artifact.`
      : endpoint
      ? "Worker endpoint is registered with durable leasing, retry budgets, and content-addressed artifact manifests. Availability still depends on the job-specific engine, inputs, controls, and calibrated model assets."
      : `Set ${worker.envKey} to register this worker. No predictions or simulations are produced until a worker is configured and executed.`,
  };
}

function validationInputAudit(run) {
  const evidenceReady = ["evidence_ready", "partial"].includes(run?.status);
  const hasTarget = typeof run?.target?.id === "string" && run.target.id.length > 0;
  const hasDisease = typeof run?.disease?.id === "string" && run.disease.id.length > 0;
  const hasMolecule = Boolean(run?.molecule?.canonicalSmiles || run?.candidate?.canonicalSmiles);
  const hasReceptor = Boolean(run?.target?.structure?.pdbId || run?.target?.structure?.alphafoldId);
  return {
    evidenceContext: {
      status: evidenceReady && hasTarget && hasDisease ? "available" : "incomplete",
      targetId: run?.target?.id ?? null,
      diseaseId: run?.disease?.id ?? null,
      evidenceRecords: run?.evidence?.items?.length ?? 0,
      literatureRecords: run?.literature?.items?.length ?? 0,
    },
    molecule: {
      status: hasMolecule ? "available" : "missing",
      requiredFor: ["molecule_prep", "docking", "admet", "retrosynthesis"],
      reason: hasMolecule ? null : "No candidate molecule structure has been attached to this run.",
    },
    receptor: {
      status: hasReceptor ? "available" : "missing",
      requiredFor: ["docking"],
      reason: hasReceptor ? null : "No prepared receptor structure or binding-pocket definition has been attached to this run.",
    },
  };
}

function buildValidationPlan(run, env = {}) {
  const workers = VALIDATION_WORKERS.map((worker) => configuredWorker(env, worker));
  const inputAudit = validationInputAudit(run);
  const configuredCount = workers.filter((worker) => worker.configured).length;
  const hasRequiredMolecule = inputAudit.molecule.status === "available";
  const hasRequiredReceptor = inputAudit.receptor.status === "available";
  const ready = configuredCount === workers.length && hasRequiredMolecule && hasRequiredReceptor;

  return {
    schemaVersion: "validation-plan.v1",
    runId: run?.id ?? null,
    generated: false,
    realDataUsed: true,
    simulationRun: false,
    status: ready ? "ready_for_worker_execution" : "blocked_missing_inputs_or_workers",
    boundary: "This plan audits readiness for open-source computational validation. It does not contain docking scores, ADMET predictions, toxicity calls, synthetic routes, wet-lab validation, or clinical validation.",
    inputAudit,
    workers,
    agentWorkflow: [
      { step: "evidence_context", label: "Evidence context", status: inputAudit.evidenceContext.status === "available" ? "completed" : "incomplete" },
      { step: "input_auditor", label: "Molecule and structure audit", status: hasRequiredMolecule && hasRequiredReceptor ? "completed" : "blocked" },
      { step: "worker_router", label: "Worker router", status: configuredCount ? "partial" : "blocked" },
      { step: "scientific_judge", label: "Scientific judge", status: "blocked" },
    ],
    nextActions: [
      "Install or register an RDKit molecule-prep worker before any chemical validation path can run.",
      "Attach or generate candidate molecule structures before ADMET, docking, or retrosynthesis.",
      "Attach a receptor structure and binding-pocket definition before docking.",
      "Register isolated open-source workers with durable job leasing and artifact persistence.",
      "Keep every result labeled as computed, predicted, literature-backed, or unavailable.",
    ],
  };
}

function validationCapabilities(env = {}) {
  return Object.fromEntries(VALIDATION_WORKERS.map((worker) => {
    const state = configuredWorker(env, worker);
    return [worker.id === "admet" ? "admet" : worker.id, {
      label: worker.label,
      status: state.status,
      configured: state.configured,
      available: false,
      batchAvailable: state.batchAvailable,
      execution: state.execution,
      provider: worker.toolchain.join(" + "),
      mode: worker.kind,
      reason: state.reason,
    }];
  }));
}

export {
  VALIDATION_WORKERS,
  buildValidationPlan,
  validationCapabilities,
};

# Development roadmap

This roadmap is the authoritative backlog for moving Axiom Observatory from a local proof of concept to a scientifically defensible campaign system. A feature is not `complete` because a binary, endpoint, or model is installed. It is complete only when its inputs, execution, controls, provenance, failure states, validation evidence, and human review are implemented together.

## Product invariant

Axiom must distinguish retrieved evidence, upstream ranking signals, computational predictions, experimental measurements, and clinical observations. Computational output never becomes experimental or clinical evidence through workflow progression. Missing inputs block execution; they do not produce defaults that resemble scientific results.

## Workstream — real docking with controls

**Goal:** execute reproducible docking rather than stopping at ligand and manifest preparation.

- Package a pinned AutoDock Vina or Smina runtime in an isolated worker.
- Ingest prepared receptors with PDB identifier, biological assembly, chain selection, protonation method, retained cofactors/waters, preparation version, and content hash.
- Require an explicit pocket definition or a source-linked co-crystal ligand; never infer an unexplained search box.
- Run deterministic seeds and configurable replicate searches while retaining poses, scores, logs, commands, engine version, CPU architecture, and wall time.
- Support crystallographic redocking with symmetry-aware ligand RMSD when a reference pose exists.
- Support same-pocket positive controls and property-matched decoys; report enrichment or discrimination separately from candidate scores.
- Detect failed preparation, invalid boxes, implausible poses, missing controls, and score instability as blocking or degraded states.
- Render pose interactions and control comparisons in the campaign UI without interpreting a docking score as binding affinity.

**Done when:** a versioned benchmark set passes declared redocking and control thresholds, every result can be reproduced from stored artifacts, and candidates cannot be ranked as docking-validated when the required control fails.

## Workstream — calibrated applicability domains

**Goal:** report when each ADMET, toxicity, activity, and ranking model is being used outside the chemistry it can support.

- Register every model with task, endpoint definition, units, training-set release, split strategy, code revision, and artifact hash.
- Calculate per-model chemical-space similarity using pinned fingerprints and distance metrics.
- Add endpoint-specific applicability-domain rules rather than one global in-domain flag.
- Evaluate calibration, coverage, MAE/RMSE or classification metrics on held-out and scaffold-split sets as appropriate.
- Add conformal intervals or another justified uncertainty method where validation data permit it.
- Distinguish `in_domain`, `borderline`, `out_of_domain`, and `not_evaluable` in API and UI contracts.
- Prevent out-of-domain predictions from silently contributing the same weight as supported predictions in comparative ranking.
- Track model and data drift and require revalidation before activating a changed model revision.

**Done when:** each displayed prediction includes a validated model revision, domain status, uncertainty/calibration evidence, and ranking policy that is tested against out-of-domain inputs.

## Workstream — real route planning

**Goal:** progress from BRICS fragment analysis to reproducible retrosynthetic route search.

- Deploy AiZynthFinder or an equivalently inspectable planner in an isolated queued worker.
- Pin expansion and filter policies, reaction-template library, stock catalogue snapshot, model revisions, search limits, and random seeds.
- Normalize starting-material identifiers, availability source, region, timestamp, and price/availability uncertainty.
- Persist the complete search tree or a reproducible bounded representation, not only the winning route.
- Return multiple routes with step count, policy likelihood, stock status, structural alerts, and explicit score definitions.
- Add known-route recovery benchmarks and negative/failure cases.
- Require medicinal/synthetic chemistry review; a proposed route is a computational hypothesis, not proof that a reaction works.

**Done when:** known-route benchmarks meet declared recovery thresholds, route artifacts can be rerun from their manifest, stock data are versioned, and failed searches remain visible.

## Workstream — assay-result ingestion and experimental feedback

**Goal:** allow measured results to update campaigns without conflating them with predictions.

- Define typed assay schemas for biochemical, biophysical, cellular, selectivity, ADME, toxicity, and PK observations.
- Ingest CSV initially, followed by API and instrument/LIMS connectors.
- Preserve protocol, biological system, construct, species, matrix, units, replicate structure, timestamps, operator/source, and raw-file references.
- Normalize units while retaining source values and transformations.
- Capture positive, negative, vehicle, blank, and plate controls plus QC acceptance rules.
- Store censored values, qualifiers, uncertainty, failed runs, and exclusions without replacing them with convenient numeric values.
- Link every measurement to registered compound/batch, target, assay version, campaign, and immutable source artifact.
- Compare predictions with measurements, calculate prospective error, and feed approved results into model monitoring—not automatic retraining.
- Require human approval for exclusions, endpoint mapping, and candidate progression.

**Done when:** a campaign can ingest a controlled assay dataset, reproduce its normalization and QC decisions, compare predictions prospectively, and retain an immutable audit trail from raw file to review decision.

## Workstream — reproducible campaign artifacts

**Goal:** make every computational and experimental decision independently auditable and rerunnable.

- Use content-addressed object storage for inputs, outputs, logs, plots, structures, models, receptor files, routes, and assay files.
- Create a signed/versioned manifest containing hashes, tool and model versions, container digest, parameters, environment, random seeds, timestamps, parent artifacts, and authorization context.
- Make artifacts immutable; corrections create a new version linked to the superseded artifact.
- Add queue idempotency, leases, heartbeat renewal, retry budgets, cancellation, dead-letter inspection, and deterministic resume behavior.
- Generate a campaign export containing the evidence snapshot, model cards, job manifests, results, controls, reviews, and decision history.
- Add automated reproducibility checks that rerun representative jobs and compare outputs within declared tolerances.

**Done when:** another authorized environment can reproduce a representative campaign from its export and explain every difference or non-deterministic tolerance.

## Workstream — Phase I model-informed simulation

**Goal:** simulate first-in-human study scenarios from adequate translational evidence, not from docking or ADMET predictions alone.

- Add a translation-readiness gate requiring formulation and physicochemical data, in-vitro ADME, animal PK, bioavailability, relevant-species toxicology, NOAEL/toxicokinetic exposure, and a justified pharmacologically active exposure or MABEL when applicable.
- Integrate a pinned Open Systems Pharmacology PK-Sim/MoBi runtime for PBPK and virtual-population simulation.
- Integrate nlmixr2/rxode2 for population PK/PD estimation, simulation, diagnostics, and visual predictive checks.
- Calculate traceable HED/MRSD scenarios and safety factors without presenting them as regulatory recommendations.
- Simulate SAD/MAD designs, sentinel dosing, escalation/stopping rules, exposure distributions, accumulation, target-exposure probability, and relevant organ-function or DDI scenarios.
- Run global sensitivity and parameter-uncertainty analyses; preserve priors and scenario assumptions.
- Require clinical pharmacology, toxicology, biostatistics, and medical review before a design can be labelled review-ready.

**Done when:** the system refuses incomplete translations, reproduces qualified reference cases, exposes uncertainty and diagnostics, and produces a review package rather than an autonomous dosing recommendation.

## Workstream — Phase II trial simulation

**Goal:** evaluate dose-selection and proof-of-concept trial designs using actual Phase I observations and explicit disease-model assumptions.

- Require ingested human PK and safety data plus appropriate PD/biomarker evidence before enabling predictive Phase II simulation.
- Model placebo response, disease progression, exposure-response, endpoint variance, heterogeneity, adherence, dropout, and missingness.
- Simulate alternative doses, sample sizes, randomization ratios, enrichment rules, trial durations, interim analyses, futility rules, and adaptive designs.
- Report operating characteristics including power, type-I error, bias, coverage, probability of success, dose-selection frequency, and failure modes.
- Separate prior-only scenario exploration from models updated with human observations.
- Validate code against analytical cases and benchmark simulations; independently review the statistical analysis plan.
- Keep protocol authoring, regulatory interaction, ethics review, trial conduct, and evidence of efficacy outside autonomous execution.

**Done when:** results are reproducible across fixed seeds, operating characteristics are independently verified, assumptions are sensitivity-tested, and the UI cannot describe simulated outcomes as observed efficacy or safety.

## Cross-cutting production gates

These apply to every milestone:

- Workspace isolation, RLS, least-privilege workers, encrypted transport, secret rotation, and auditable access.
- Structured logs, traces, metrics, queue dashboards, provenance-completeness alerts, backup, and disaster recovery.
- Model cards, data licences, intended-use statements, validation reports, drift monitoring, rollback, and change approval.
- Golden datasets, failure fixtures, prospective validation, and documented acceptance thresholds.
- Human scientific review with named role, timestamp, rationale, evidence snapshot, and conflict-of-interest disclosure where required.

## Delivery order

1. Reproducible artifact foundation and worker operations.
2. Real docking with controls.
3. Calibrated applicability domains.
4. Real route planning.
5. Assay-result ingestion and prospective prediction-versus-measurement evaluation.
6. Phase I model-informed simulation after translational data gates.
7. Phase II simulation after human Phase I data ingestion.

Artifact foundations begin first and mature alongside every later milestone. Clinical simulation cannot bypass preclinical, assay, or human-data readiness gates.

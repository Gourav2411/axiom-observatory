import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { loadEnv } from "vite";

const fileEnv = loadEnv(process.env.NODE_ENV || "development", process.cwd(), "");
const supabaseUrl = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
const chemistryUrl = (process.env.AXIOM_CHEMISTRY_URL || fileEnv.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");
const workerId = `local-campaign-${randomUUID()}`;
const pollMs = Number(process.env.AXIOM_CAMPAIGN_POLL_MS || 2_000);
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function chemistry(path, body) {
  const response = await fetch(`${chemistryUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.detail || `Chemistry worker returned HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function descriptorApplicability(prepared) {
  const d = prepared.descriptors || {};
  const checks = [
    ["molecularWeight", d.molecularWeight, 100, 700],
    ["logP", d.logP, -3, 7],
    ["tpsa", d.tpsa, 0, 220],
    ["hBondDonors", d.hBondDonors, 0, 10],
    ["hBondAcceptors", d.hBondAcceptors, 0, 15],
    ["rotatableBonds", d.rotatableBonds, 0, 20],
  ].map(([name, value, min, max]) => ({ name, value, range: [min, max], inside: Number.isFinite(value) && value >= min && value <= max }));
  const inside = checks.filter((item) => item.inside).length;
  return {
    status: inside === checks.length ? "inside_proxy_domain" : inside >= 4 ? "borderline_proxy_domain" : "outside_proxy_domain",
    method: "declared physicochemical-range coverage proxy",
    coverage: inside / checks.length,
    checks,
    limitation: "This is not the ADMET-AI training-set applicability domain; training fingerprints and ensemble uncertainty are unavailable.",
  };
}

function prepScore(result) {
  const qed = Number(result.descriptors?.qed || 0);
  const lipinski = result.drugLikeness?.passes ? 5 : 0;
  const alertPenalty = Math.min(8, (result.structuralAlerts?.length || 0) * 2);
  return { eligible: true, points: Math.max(0, qed * 20 + lipinski - alertPenalty), maxPoints: 25, method: "QED + Lipinski − structural-alert penalty" };
}

function admetScore(result) {
  const endpoints = new Map((result.endpoints || []).map((item) => [String(item.id).toLowerCase(), Number(item.value)]));
  const risks = ["herg", "ames", "dili", "clintox"].map((id) => ({ id, probability: endpoints.get(id) })).filter((item) => Number.isFinite(item.probability));
  const meanRisk = risks.length ? risks.reduce((sum, item) => sum + item.probability, 0) / risks.length : 1;
  return { eligible: risks.length > 0, points: Math.max(0, (1 - meanRisk) * 45), maxPoints: 45, method: "inverse mean predicted hERG/Ames/DILI/ClinTox positive-class probability", risks };
}

function admetApplicability(result) {
  const endpoints = result.endpoints || [];
  const supported = endpoints.filter((item) => Number.isFinite(item.performance?.auroc) || Number.isFinite(item.performance?.r2) || Number.isFinite(item.performance?.mae)).length;
  return {
    status: "performance_metadata_only",
    method: "endpoint performance-metadata coverage",
    coverage: endpoints.length ? supported / endpoints.length : 0,
    supportedEndpoints: supported,
    totalEndpoints: endpoints.length,
    limitation: "Endpoint benchmark metadata does not establish whether this molecule lies inside any model's training domain.",
  };
}

function fragmentScore(result) {
  const count = result.fragments?.length || 0;
  return { eligible: true, points: count ? Math.max(2, 10 - Math.max(0, count - 3) * 1.5) : 0, maxPoints: 10, method: "BRICS fragment-count prioritization proxy" };
}

function blockedResult(job, reason, requirement) {
  return {
    status: "blocked",
    result: { reason, requirement },
    applicability: { status: "not_assessed", reason },
    score: { eligible: false, points: 0, maxPoints: 0, method: "excluded because capability is unavailable" },
    boundary: job.job_type === "docking_score"
      ? "No docking engine executed; no poses, affinities, redocking control, or binding claims exist."
      : "No AiZynthFinder policy search executed; no synthetic route, yield, or laboratory feasibility claim exists.",
  };
}

async function execute(job) {
  const payload = job.payload || {};
  const smiles = payload.smiles;
  const settings = payload.campaignSettings || {};
  if (job.job_type === "molecule_prep") {
    const result = await chemistry("/prepare", { smiles, largest_fragment: true, neutralize: true, canonical_tautomer: true, generate_3d: true });
    return { status: "succeeded", result, applicability: descriptorApplicability(result), score: prepScore(result), boundary: result.boundary };
  }
  if (job.job_type === "admet") {
    const result = await chemistry("/admet", { smiles });
    return { status: "succeeded", result, applicability: admetApplicability(result), score: admetScore(result), boundary: result.boundary };
  }
  if (job.job_type === "docking_prepare") {
    if (!settings.receptorId || !settings.center || !settings.size) return blockedResult(job, "Receptor and explicit pocket box are required.", "receptorId, center and size");
    const result = await chemistry("/docking/prepare", { smiles, receptor_id: settings.receptorId, center: settings.center, size: settings.size, exhaustiveness: settings.exhaustiveness || 8, seed: settings.seed || 20260803 });
    return { status: "succeeded", result, applicability: { status: "inputs_prepared", method: "deterministic ligand and grid preparation" }, score: { eligible: false, points: 0, maxPoints: 0, method: "preparation does not rank candidates" }, boundary: result.boundary };
  }
  if (job.job_type === "docking_score") {
    if (!settings.receptorPath || !settings.receptorId || !settings.center || !settings.size) return blockedResult(job, "Actual docking needs a prepared receptor PDBQT path and explicit pocket box.", "receptorPath, receptorId, center and size");
    try {
      const result = await chemistry("/docking/run", { smiles, receptor_id: settings.receptorId, receptor_path: settings.receptorPath, center: settings.center, size: settings.size, exhaustiveness: settings.exhaustiveness || 8, seed: settings.seed || 20260803, control_smiles: settings.controlSmiles || null });
      const affinity = Number(result.bestAffinity);
      return { status: "succeeded", result, applicability: result.control || { status: "control_not_supplied" }, score: { eligible: Number.isFinite(affinity), points: Number.isFinite(affinity) ? Math.max(0, Math.min(15, -affinity * 1.5)) : 0, maxPoints: 15, method: "bounded Vina affinity prioritization signal" }, boundary: result.boundary };
    } catch (error) {
      if (error.status === 503 || error.status === 422) return blockedResult(job, error.message, "compatible Vina binary, prepared receptor and valid control inputs");
      throw error;
    }
  }
  if (job.job_type === "retrosynthesis_fragments") {
    const result = await chemistry("/retrosynthesis/fragments", { smiles });
    return { status: "succeeded", result, applicability: { status: "rule_based", method: "RDKit BRICS decomposition" }, score: fragmentScore(result), boundary: result.boundary };
  }
  if (job.job_type === "route_planning") {
    try {
      const result = await chemistry("/retrosynthesis/plan", { smiles, max_transforms: settings.maxTransforms || 6, time_limit_seconds: settings.routeTimeLimitSeconds || 120 });
      return { status: "succeeded", result, applicability: result.applicability || { status: "policy_domain_unreported" }, score: { eligible: true, points: result.routes?.length ? 5 : 0, maxPoints: 5, method: "route-found indicator; not yield or feasibility" }, boundary: result.boundary };
    } catch (error) {
      if (error.status === 503 || error.status === 422) return blockedResult(job, error.message, "AiZynthFinder binary, expansion policy, filter policy and stock database");
      throw error;
    }
  }
  throw new Error(`Unsupported campaign job type: ${job.job_type}`);
}

async function complete(job, outcome, error = null) {
  const { error: rpcError } = await supabase.rpc("complete_campaign_job_v1", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_status: outcome?.status || "failed",
    p_result: outcome?.result || {},
    p_error: error ? { code: "worker_failure", message: String(error.message || error).slice(0, 500) } : null,
    p_applicability: outcome?.applicability || { status: "not_assessed" },
    p_score_component: outcome?.score || { eligible: false, points: 0, maxPoints: 0 },
    p_boundary: outcome?.boundary || "The worker failed before a scientific result was produced.",
  });
  if (rpcError) throw rpcError;
}

async function cycle() {
  const { data: jobs, error } = await supabase.rpc("lease_campaign_jobs_v1", { p_worker_id: workerId, p_limit: 1, p_lease_seconds: 600 });
  if (error) throw error;
  for (const job of jobs || []) {
    try {
      await complete(job, await execute(job));
    } catch (jobError) {
      console.error(`Campaign job ${job.job_type} failed:`, jobError.message);
      await complete(job, null, jobError).catch((completionError) => console.error("Unable to record campaign job failure:", completionError.message));
    }
  }
  return jobs?.length || 0;
}

if (!supabase) {
  console.warn("Campaign worker is disabled because Supabase server credentials are not configured.");
} else {
  console.log(`Campaign worker ${workerId} connected.`);
  while (true) {
    try {
      const processed = await cycle();
      if (!processed) await wait(pollMs);
    } catch (error) {
      console.error("Campaign worker polling failed:", error.message);
      await wait(Math.max(pollMs, 5_000));
    }
  }
}

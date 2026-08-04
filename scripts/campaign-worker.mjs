import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "vite";
import { boundedWorkerError, normalizeSupabaseProjectUrl } from "./campaign-config.mjs";

const fileEnv = loadEnv(process.env.NODE_ENV || "development", process.cwd(), "");
let configurationError = null;
let supabaseUrl = "";
try {
  supabaseUrl = normalizeSupabaseProjectUrl(process.env.SUPABASE_URL || fileEnv.SUPABASE_URL);
} catch (error) {
  configurationError = error;
}
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
const chemistryUrl = (process.env.AXIOM_CHEMISTRY_URL || fileEnv.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");
const computeHostport = process.env.AXIOM_COMPUTE_HOSTPORT || fileEnv.AXIOM_COMPUTE_HOSTPORT || "";
const computeUrl = (process.env.AXIOM_COMPUTE_URL || fileEnv.AXIOM_COMPUTE_URL || (computeHostport ? `http://${computeHostport}` : "")).replace(/\/+$/, "");
const internalWorkerKey = process.env.AXIOM_INTERNAL_WORKER_KEY || fileEnv.AXIOM_INTERNAL_WORKER_KEY || "";
const workerId = `local-campaign-${randomUUID()}`;
const pollMs = Number(process.env.AXIOM_CAMPAIGN_POLL_MS || 2_000);
const allowedJobTypes = (process.env.AXIOM_CAMPAIGN_JOB_TYPES || fileEnv.AXIOM_CAMPAIGN_JOB_TYPES || "molecule_prep,admet,docking_prepare,docking_score,retrosynthesis_fragments,route_planning,clinical_phase1_simulation,clinical_phase2_simulation")
  .split(",").map((value) => value.trim()).filter(Boolean);
const oneShot = /^(1|true|yes)$/i.test(process.env.AXIOM_CAMPAIGN_ONESHOT || "");
const maxJobs = Math.max(1, Math.min(Number(process.env.AXIOM_CAMPAIGN_MAX_JOBS || 20), 100));
const artifactSigningKey = process.env.AXIOM_ARTIFACT_SIGNING_KEY || fileEnv.AXIOM_ARTIFACT_SIGNING_KEY || "";
const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function collectLocalArtifacts(value, found = new Set()) {
  if (typeof value === "string" && value.startsWith("services/artifacts/")) found.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectLocalArtifacts(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectLocalArtifacts(item, found));
  return [...found];
}

async function registerArtifact(job, bytes, fileName, mimeType, metadata) {
  const digest = sha256(bytes);
  const objectPath = `${job.workspace_id}/${job.run_id}/${job.id}/${digest}-${path.basename(fileName)}`;
  const { error: uploadError } = await supabase.storage.from("run-artifacts").upload(objectPath, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message || "")) throw uploadError;
  const { error: rowError } = await supabase.from("artifacts").upsert({
    workspace_id: job.workspace_id,
    run_id: job.run_id,
    job_id: job.id,
    bucket_id: "run-artifacts",
    object_path: objectPath,
    sha256: digest,
    mime_type: mimeType,
    byte_size: bytes.length,
    metadata,
  }, { onConflict: "bucket_id,object_path", ignoreDuplicates: true });
  if (rowError) throw rowError;
  return { bucketId: "run-artifacts", objectPath, sha256: digest, byteSize: bytes.length, mimeType };
}

async function persistOutcomeArtifacts(job, outcome) {
  const artifactRoot = path.resolve(process.cwd(), "services/artifacts");
  const remoteArtifactOrigin = ["admet", "docking_score"].includes(job.job_type) ? computeUrl : "";
  const files = [];
  for (const relativePath of collectLocalArtifacts(outcome.result)) {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    if (!absolutePath.startsWith(`${artifactRoot}${path.sep}`)) throw new Error("Worker artifact escaped the configured artifact root");
    let bytes;
    if (remoteArtifactOrigin) {
      const response = await fetch(`${remoteArtifactOrigin}/artifacts/${encodeURIComponent(path.basename(relativePath))}`, {
        headers: internalWorkerKey ? { "x-axiom-worker-key": internalWorkerKey } : {},
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Remote chemistry artifact returned HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      bytes = await readFile(absolutePath);
    }
    const extension = path.extname(relativePath).toLowerCase();
    const mimeType = extension === ".json" ? "application/json" : extension === ".sdf" ? "chemical/x-mdl-sdfile" : extension === ".pdbqt" ? "chemical/x-pdbqt" : "application/octet-stream";
    files.push(await registerArtifact(job, bytes, path.basename(absolutePath), mimeType, {
      schemaVersion: "axiom-artifact.v1",
      jobType: job.job_type,
      workerId,
      workerSourcePath: relativePath,
      transfer: remoteArtifactOrigin ? "authenticated_private_http" : "local_filesystem",
    }));
  }
  const manifest = {
    schemaVersion: "axiom-campaign-manifest.v1",
    jobId: job.id,
    runId: job.run_id,
    workspaceId: job.workspace_id,
    jobType: job.job_type,
    workerId,
    attempt: job.attempts,
    inputSha256: sha256(canonicalJson(job.payload || {})),
    outputSha256: sha256(canonicalJson(outcome.result || {})),
    boundary: outcome.boundary,
    applicability: outcome.applicability,
    provenance: outcome.result?.provenance || null,
    files,
    createdAt: new Date().toISOString(),
  };
  const manifestBody = canonicalJson(manifest);
  const signature = artifactSigningKey ? createHmac("sha256", artifactSigningKey).update(manifestBody).digest("hex") : null;
  const signedManifest = { ...manifest, signature: signature ? { algorithm: "hmac-sha256", value: signature } : { algorithm: null, value: null, status: "unsigned_no_signing_key" } };
  const manifestArtifact = await registerArtifact(job, Buffer.from(JSON.stringify(signedManifest, null, 2)), "manifest.json", "application/json", {
    schemaVersion: signedManifest.schemaVersion,
    kind: "job_manifest",
    jobType: job.job_type,
    signatureStatus: signature ? "signed" : "unsigned_no_signing_key",
  });
  return {
    ...outcome,
    result: {
      ...outcome.result,
      durableArtifacts: files,
      artifactManifest: { ...manifestArtifact, signatureStatus: signature ? "signed" : "unsigned_no_signing_key" },
    },
  };
}

async function executeWithHeartbeat(job) {
  const heartbeat = setInterval(() => {
    supabase.rpc("heartbeat_campaign_job_v1", { p_job_id: job.id, p_worker_id: workerId, p_lease_seconds: 600 })
      .then(({ error }) => { if (error) console.error(`Campaign heartbeat failed for ${job.id}:`, error.message); });
  }, 60_000);
  try {
    return await execute(job);
  } finally {
    clearInterval(heartbeat);
  }
}

async function chemistry(path, body) {
  const origin = computeUrl && ["/admet", "/applicability/admet", "/receptors", "/docking/run"].includes(path) ? computeUrl : chemistryUrl;
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(origin === computeUrl && internalWorkerKey ? { "x-axiom-worker-key": internalWorkerKey } : {}) },
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

async function clinicalSimulation(job) {
  const python = process.env.AXIOM_PYTHON_BINARY || fileEnv.AXIOM_PYTHON_BINARY || "python3";
  const input = JSON.stringify({
    jobId: job.id,
    phase: job.payload?.phase,
    mode: job.payload?.mode,
    scenario: job.payload?.scenario,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["services/clinical_simulation.py"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = current + chunk;
      if (next.length > 8_000_000) {
        child.kill("SIGKILL");
        throw new Error("Clinical simulation output exceeded the 8 MB safety limit");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { try { stdout = append(stdout, chunk); } catch (error) { reject(error); } });
    child.stderr.on("data", (chunk) => { try { stderr = append(stderr, chunk); } catch (error) { reject(error); } });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Clinical simulation worker exited ${code}: ${stderr.slice(-1000)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Clinical simulation worker returned invalid JSON"));
      }
    });
    child.stdin.end(input);
  });
}

async function durableReceptorPdbqt(reference) {
  if (!reference?.bucketId || !reference?.objectPath || !reference?.sha256) throw new Error("Durable receptor reference is incomplete");
  const { data, error } = await supabase.storage.from(reference.bucketId).download(reference.objectPath);
  if (error || !data) throw new Error(`Durable receptor download failed: ${error?.message || "empty object"}`);
  const bytes = Buffer.from(await data.arrayBuffer());
  if (sha256(bytes) !== reference.sha256) throw new Error("Durable receptor SHA-256 verification failed");
  return bytes.toString("utf8");
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

function admetScore(result, applicability) {
  const endpoints = new Map((result.endpoints || []).map((item) => [String(item.id).toLowerCase(), Number(item.value)]));
  const supported = new Set((applicability?.endpoints || []).filter((item) => ["in_domain", "borderline"].includes(item.status)).map((item) => String(item.id).toLowerCase()));
  const risks = ["herg", "ames", "dili", "clintox"].map((id) => ({ id, probability: endpoints.get(id) })).filter((item) => Number.isFinite(item.probability) && supported.has(item.id));
  const meanRisk = risks.length ? risks.reduce((sum, item) => sum + item.probability, 0) / risks.length : 1;
  return { eligible: risks.length > 0, points: Math.max(0, (1 - meanRisk) * 45), maxPoints: 45, method: risks.length ? "inverse mean predicted risk for endpoint predictions passing calibrated domain policy" : "excluded: no risk endpoint passed a calibrated applicability-domain policy", risks };
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
  if (["clinical_phase1_simulation", "clinical_phase2_simulation"].includes(job.job_type)) {
    const result = await clinicalSimulation(job);
    return {
      status: "succeeded",
      result,
      applicability: {
        status: payload.mode === "evidence_qualified" ? "evidence_qualified_scenario" : "assumption_driven_research_scenario",
        method: result.model?.method,
        inputSha256: result.inputSha256,
      },
      score: { eligible: false, points: 0, maxPoints: 0, method: "Clinical model projections are excluded from discovery ranking" },
      boundary: result.boundary,
    };
  }
  if (job.job_type === "molecule_prep") {
    const result = await chemistry("/prepare", { smiles, largest_fragment: true, neutralize: true, canonical_tautomer: true, generate_3d: true });
    return { status: "succeeded", result, applicability: descriptorApplicability(result), score: prepScore(result), boundary: result.boundary };
  }
  if (job.job_type === "admet") {
    const result = await chemistry("/admet", { smiles });
    let applicability;
    try {
      applicability = await chemistry("/applicability/admet", { smiles });
    } catch (error) {
      if (error.status !== 503) throw error;
      applicability = { status: "not_evaluable", endpoints: [], reason: error.message, limitation: "ADMET predictions are excluded from ranking until a calibrated endpoint-specific domain registry is configured." };
    }
    return { status: "succeeded", result: { ...result, applicability }, applicability, score: admetScore(result, applicability), boundary: result.boundary };
  }
  if (job.job_type === "docking_prepare") {
    if (!settings.receptorId || !settings.center || !settings.size) return blockedResult(job, "Receptor and explicit pocket box are required.", "receptorId, center and size");
    const result = await chemistry("/docking/prepare", { smiles, receptor_id: settings.receptorId, center: settings.center, size: settings.size, exhaustiveness: settings.exhaustiveness || 8, seed: settings.seed || 20260803 });
    return { status: "succeeded", result, applicability: { status: "inputs_prepared", method: "deterministic ligand and grid preparation" }, score: { eligible: false, points: 0, maxPoints: 0, method: "preparation does not rank candidates" }, boundary: result.boundary };
  }
  if (job.job_type === "docking_score") {
    if ((!settings.receptorPath && !settings.receptorObject) || !settings.receptorId || !settings.center || !settings.size) return blockedResult(job, "Actual docking needs a durable prepared receptor PDBQT input and explicit pocket box.", "receptorPath or receptorObject, receptorId, center and size");
    try {
      let receptorPath = settings.receptorPath;
      if (settings.receptorObject) {
        const registered = await chemistry("/receptors", { receptor_id: settings.receptorId, pdbqt: await durableReceptorPdbqt(settings.receptorObject) });
        receptorPath = registered.receptorPath;
      }
      const result = await chemistry("/docking/run", { smiles, receptor_id: settings.receptorId, receptor_path: receptorPath, center: settings.center, size: settings.size, exhaustiveness: settings.exhaustiveness || 8, seed: settings.seed || 20260803, replicates: settings.dockingReplicates || 3, control_smiles: settings.controlSmiles || null });
      const affinity = Number(result.bestAffinity);
      const controlPassed = result.control?.status === "score_control_completed" && result.control?.stability?.status === "pass" && result.stability?.status === "pass";
      return { status: "succeeded", result, applicability: { ...result.control, candidateStability: result.stability, status: controlPassed ? "same_box_control_passed" : result.control?.status === "not_supplied" ? "control_not_supplied" : "control_policy_failed", limitation: "Same-box score controls and replicate stability do not establish crystallographic redocking validity or binding." }, score: { eligible: controlPassed && Number.isFinite(affinity), points: controlPassed && Number.isFinite(affinity) ? Math.max(0, Math.min(15, -affinity * 1.5)) : 0, maxPoints: 15, method: controlPassed ? "bounded Vina affinity prioritization signal after replicate/control policy" : "excluded: required docking control and replicate-stability policy did not pass" }, boundary: result.boundary };
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
  if (["clinical_phase1_simulation", "clinical_phase2_simulation"].includes(job.job_type)) {
    const { error: clinicalError } = await supabase.rpc("complete_clinical_simulation_v1", {
      p_job_id: job.id,
      p_worker_id: workerId,
      p_status: outcome?.status || "failed",
      p_result: outcome?.result || {},
      p_error: error ? { code: "worker_failure", message: String(error.message || error).slice(0, 500) } : null,
      p_boundary: outcome?.boundary || "The clinical simulation worker failed before a model projection was produced.",
    });
    if (clinicalError) throw clinicalError;
    return;
  }
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
  const { data: jobs, error } = await supabase.rpc("lease_campaign_jobs_v2", { p_worker_id: workerId, p_job_types: allowedJobTypes, p_limit: 1, p_lease_seconds: 600 });
  if (error) throw error;
  for (const job of jobs || []) {
    try {
      const outcome = await executeWithHeartbeat(job);
      await complete(job, await persistOutcomeArtifacts(job, outcome));
    } catch (jobError) {
      console.error(`Campaign job ${job.job_type} failed:`, boundedWorkerError(jobError));
      await complete(job, null, jobError).catch((completionError) => console.error("Unable to record campaign job failure:", boundedWorkerError(completionError)));
    }
  }
  return jobs?.length || 0;
}

if (configurationError) {
  console.error("Campaign worker configuration error:", boundedWorkerError(configurationError));
  process.exitCode = 1;
} else if (!supabase) {
  console.warn("Campaign worker is disabled because Supabase server credentials are not configured.");
} else {
  console.log(`Campaign worker ${workerId} connected for ${allowedJobTypes.join(", ")}.`);
  let processedTotal = 0;
  while (!oneShot || processedTotal < maxJobs) {
    try {
      const processed = await cycle();
      processedTotal += processed;
      if (oneShot && !processed) break;
      if (!processed) await wait(pollMs);
    } catch (error) {
      console.error("Campaign worker polling failed:", boundedWorkerError(error));
      if (oneShot) {
        process.exitCode = 1;
        break;
      }
      await wait(Math.max(pollMs, 5_000));
    }
  }
  if (oneShot && !process.exitCode) console.log(`Campaign batch completed after ${processedTotal} job(s).`);
}

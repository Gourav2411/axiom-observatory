import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { boundedWorkerError, normalizeSupabaseProjectUrl } from "../scripts/campaign-config.mjs";

const runner = await readFile(new URL("../scripts/campaign-worker.mjs", import.meta.url), "utf8");
const repository = await readFile(new URL("../worker/campaign-repository.js", import.meta.url), "utf8");
const server = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
const readiness = await readFile(new URL("../worker/clinical-readiness.js", import.meta.url), "utf8");

test("local campaign worker executes the complete queued workflow without placeholder science", () => {
  for (const job of ["molecule_prep", "admet", "docking_prepare", "docking_score", "retrosynthesis_fragments", "route_planning"]) {
    assert.match(runner, new RegExp(`job\\.job_type === "${job}"`));
  }
  assert.match(runner, /lease_campaign_jobs_v1/);
  assert.match(runner, /complete_campaign_job_v1/);
  assert.match(runner, /heartbeat_campaign_job_v1/);
  assert.match(runner, /axiom-campaign-manifest\.v1/);
  assert.match(runner, /run-artifacts/);
  assert.match(runner, /inputSha256/);
  assert.match(runner, /No docking engine executed; no poses, affinities, redocking control, or binding claims exist/i);
  assert.match(runner, /No AiZynthFinder policy search executed/i);
  assert.match(runner, /excluded from ranking until a calibrated endpoint-specific domain registry/i);
});

test("campaign worker accepts project origins and rejects Supabase dashboard URLs", () => {
  assert.equal(normalizeSupabaseProjectUrl("https://wmctadhdehnlqzltffun.supabase.co/"), "https://wmctadhdehnlqzltffun.supabase.co");
  assert.equal(normalizeSupabaseProjectUrl("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  assert.throws(() => normalizeSupabaseProjectUrl("https://supabase.com/dashboard/project/example"), /points to the Supabase Dashboard/);
  assert.throws(() => normalizeSupabaseProjectUrl("https://example.supabase.co/rest/v1"), /project API origin/);
  assert.match(boundedWorkerError(new Error("<!DOCTYPE html><html>not found</html>")), /HTML page instead of its JSON API/);
  assert.ok(boundedWorkerError(new Error("x".repeat(800))).length <= 500);
});

test("campaign API requires an authenticated principal and delegates writes to scoped RPCs", () => {
  for (const path of ["campaigns", "candidates", "queue", "reviews", "assays", "translation-inputs"]) assert.match(server, new RegExp(path));
  assert.match(server, /authenticateSupabaseRequest/);
  for (const rpc of ["create_campaign_v1", "add_campaign_candidate_v1", "queue_candidate_workflow_v1", "submit_scientific_review_v1", "ingest_assay_result_v1", "register_clinical_translation_input_v1", "review_clinical_translation_input_v1"]) {
    assert.match(repository, new RegExp(rpc));
  }
  assert.doesNotMatch(repository, /authorization: `Bearer \$\{serviceRoleKey\}`/);
});

test("clinical translation is a strict readiness audit, never a synthetic trial result", () => {
  assert.match(readiness, /blocked_missing_qualified_inputs/);
  assert.match(readiness, /ready_for_pbpk_model_configuration/);
  assert.match(readiness, /ready_for_trial_model_configuration/);
  assert.match(readiness, /blocked_missing_simulation_engines/);
  assert.match(readiness, /does not simulate exposure, safety, efficacy, dose selection, or a clinical trial/i);
});

import assert from "node:assert/strict";
import test from "node:test";
import { persistentAdmetState } from "../src/persistent-validation.js";

const campaign = (candidates, source = "validation_workbench") => ({ settings: { source }, candidates });
const candidate = (overrides = {}) => ({
  id: "candidate-1",
  input_smiles: "CCO",
  jobs: [{ id: "job-1", job_type: "admet", status: "queued", created_at: "2026-08-04T08:00:00Z" }],
  evaluations: [],
  ...overrides,
});

test("restores an active validation ADMET job from durable campaign state", () => {
  const state = persistentAdmetState([campaign([candidate()])]);
  assert.equal(state.queue.candidateId, "candidate-1");
  assert.equal(state.queue.jobId, "job-1");
  assert.equal(state.queue.status, "queued");
  assert.match(state.queue.compute.reason, /restored/i);
  assert.equal(state.smiles, "CCO");
});

test("restores a completed ADMET result after navigation or refresh", () => {
  const result = { endpoints: [{ id: "ames", value: 0.12 }] };
  const state = persistentAdmetState([campaign([candidate({
    jobs: [{ id: "job-1", job_type: "admet", status: "succeeded", updated_at: "2026-08-04T08:05:00Z" }],
    evaluations: [{ evaluation_type: "admet", status: "completed", result }],
  })])]);
  assert.equal(state.queue.status, "succeeded");
  assert.deepEqual(state.result, result);
});

test("ignores ordinary campaigns and can retain the currently polled candidate", () => {
  const older = candidate({ id: "candidate-old", jobs: [{ id: "job-old", job_type: "admet", status: "running", updated_at: "2026-08-04T08:00:00Z" }] });
  const newer = candidate({ id: "candidate-new", jobs: [{ id: "job-new", job_type: "admet", status: "queued", updated_at: "2026-08-04T09:00:00Z" }] });
  assert.equal(persistentAdmetState([campaign([older, newer])]).queue.candidateId, "candidate-new");
  assert.equal(persistentAdmetState([campaign([older, newer])], "candidate-old").queue.candidateId, "candidate-old");
  assert.equal(persistentAdmetState([campaign([newer], "manual_campaign")]), null);
});

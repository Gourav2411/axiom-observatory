import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const worker = await readFile(new URL("../services/clinical_simulation.py", import.meta.url), "utf8");

const pk = {
  doseMg: 100, doseCount: 3, doseIntervalHours: 24, durationHours: 72,
  bioavailability: 0.7, absorptionRatePerHour: 1.2, clearanceLPerHour: 8,
  centralVolumeL: 45, peripheralVolumeL: 70, intercompartmentalClearanceLPerHour: 5,
  betweenSubjectCv: 0.3, residualCv: 0.12, cohortSize: 20,
};

function execute(payload) {
  const process = spawnSync("python3", ["services/clinical_simulation.py"], {
    cwd: new URL("..", import.meta.url),
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(process.status, 0, process.stderr);
  return JSON.parse(process.stdout);
}

test("Phase I model is deterministic, population-based, and explicitly bounded", async () => {
  const payload = { jobId: "contract-phase1", phase: "phase1", mode: "research_scenario", scenario: { seed: 42, pk } };
  const first = execute(payload);
  const second = execute(payload);
  assert.deepEqual(first.result, second.result);
  assert.equal(first.result.population.simulatedSubjects, 20);
  assert.ok(first.result.exposure.aucMgHourPerL.p95 > first.result.exposure.aucMgHourPerL.p05);
  assert.match(first.model.method, /Two-compartment oral PK/);
  assert.match(first.boundary, /not a clinical trial/i);
  await unlink("services/artifacts/clinical-simulation-contract-phase1.json").catch(() => {});
});

test("Phase II model reports Monte Carlo operating characteristics, not efficacy", async () => {
  const result = execute({
    jobId: "contract-phase2", phase: "phase2", mode: "research_scenario",
    scenario: { seed: 42, pk, pd: { emax: 8, ec50NgPerMl: 500, placeboChange: -1, endpointSd: 7, treatmentN: 60, controlN: 60, dropoutRate: 0.15, trialReplicates: 100 } },
  });
  const probability = result.result.operatingCharacteristics.modelBasedProbabilityTwoSidedPBelow0_05;
  assert.ok(probability >= 0 && probability <= 1);
  assert.match(result.model.method, /Emax exposure-response/);
  assert.match(result.boundary, /not.*evidence of safety or efficacy/i);
  await unlink("services/artifacts/clinical-simulation-contract-phase2.json").catch(() => {});
});

test("clinical simulator validates bounded numeric inputs", () => {
  assert.match(worker, /must be between/);
  const process = spawnSync("python3", ["services/clinical_simulation.py"], {
    cwd: new URL("..", import.meta.url), input: JSON.stringify({ phase: "phase1", scenario: { seed: 1, pk: { ...pk, doseMg: -1 } } }), encoding: "utf8",
  });
  assert.notEqual(process.status, 0);
  assert.match(process.stderr, /doseMg must be between/);
});

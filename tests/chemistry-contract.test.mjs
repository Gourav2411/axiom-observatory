import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(new URL("../services/chemistry_worker.py", import.meta.url), "utf8");
const api = await readFile(new URL("../src/api.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../src/LiveApp.jsx", import.meta.url), "utf8");

test("local chemistry worker exposes real preparation and prediction boundaries", () => {
  assert.match(service, /@app\.post\("\/prepare"\)/);
  assert.match(service, /@app\.post\("\/admet"\)/);
  assert.match(service, /ADMETModel/);
  assert.match(service, /not measured safety, toxicity, exposure, or clinical outcomes/i);
  assert.match(service, /RDKit ETKDGv3 \+ MMFF94/);
});

test("docking and retrosynthesis paths cannot fabricate engine outputs", () => {
  assert.match(service, /prepared_waiting_engine/);
  assert.match(service, /No docking engine ran/i);
  assert.match(service, /BRICS decomposition/i);
  assert.match(service, /not an AiZynthFinder route/i);
  assert.match(service, /@app\.post\("\/docking\/run"\)/);
  assert.match(service, /@app\.post\("\/retrosynthesis\/plan"\)/);
  assert.match(service, /subprocess\.run/);
  assert.match(service, /No compatible AutoDock Vina binary is registered/i);
  assert.match(service, /AiZynthFinder route planning requires a binary/i);
});

test("frontend exposes every local chemistry operation", () => {
  for (const operation of ["prepareMolecule", "predictAdmet", "prepareDocking", "fragmentRetrosynthesis", "listCampaigns", "queueCandidate", "reviewCandidate"]) {
    assert.match(api, new RegExp(operation));
  }
  assert.match(ui, /Open-source validation workbench/);
  assert.match(ui, /COMPUTATIONAL PREDICTION/);
  assert.match(ui, /Asynchronous discovery campaign/);
  assert.match(ui, /Real execution, capability-gated/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../scripts/serve-production.mjs", import.meta.url), "utf8");
const launcher = await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../deploy/Dockerfile", import.meta.url), "utf8");
const computeDockerfile = await readFile(new URL("../deploy/Dockerfile.compute", import.meta.url), "utf8");
const chemistryWorkflow = await readFile(new URL("../.github/workflows/chemistry-compute.yml", import.meta.url), "utf8");
const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
const chemistryWorker = await readFile(new URL("../services/chemistry_worker.py", import.meta.url), "utf8");
const baseRequirements = await readFile(new URL("../services/requirements-chemistry-base.txt", import.meta.url), "utf8");

test("production server serves the SPA and protects computational chemistry", () => {
  assert.match(server, /dist\/client/);
  assert.match(server, /authenticateSupabaseRequest/);
  assert.match(server, /chemistryRoutes/);
  assert.match(server, /targetPath !== "\/health"/);
  assert.match(server, /authentication_required/);
  assert.match(server, /path\.join\(assetRoot, "index\.html"\)/);
});

test("production web container keeps lightweight auditable processes", () => {
  for (const processName of ["chemistry_worker.py", "campaign-worker.mjs", "serve-production.mjs"]) assert.match(launcher, new RegExp(processName.replace(".", "\\.")));
  assert.match(dockerfile, /FROM node:22\.19-bookworm-slim AS web-build/);
  assert.match(dockerfile, /FROM python:3\.12-slim AS runtime/);
  assert.match(dockerfile, /requirements-chemistry-base\.txt/);
  assert.doesNotMatch(dockerfile, /requirements-admet\.txt/);
  assert.match(dockerfile, /libxrender1/);
  assert.match(dockerfile, /libexpat1/);
  assert.doesNotMatch(chemistryWorker, /^from admet_ai import/m);
  assert.match(chemistryWorker, /lazy_on_first_prediction/);
  assert.match(chemistryWorker, /AXIOM_ADMET_EXECUTION_ENABLED/);
  assert.match(blueprint, /AXIOM_ADMET_EXECUTION_ENABLED[\s\S]*value: "false"/);
  assert.match(dockerfile, /libxext6/);
  assert.match(dockerfile, /libsm6/);
  assert.match(baseRequirements, /scipy==1\.15\.3/);
  assert.match(dockerfile, /from meeko import MoleculePreparation, PDBQTWriterLegacy/);
  assert.match(dockerfile, /start-production\.mjs/);
});

test("GitHub Actions batches heavy chemistry without a paid Render service", () => {
  assert.match(computeDockerfile, /requirements-admet\.txt/);
  assert.match(computeDockerfile, /VINA_VERSION=1\.2\.7/);
  assert.match(computeDockerfile, /sha256sum --check/);
  assert.match(chemistryWorkflow, /workflow_dispatch:/);
  assert.match(chemistryWorkflow, /ubuntu-latest/);
  assert.match(chemistryWorkflow, /AXIOM_CAMPAIGN_JOB_TYPES: admet,docking_score/);
  assert.match(chemistryWorkflow, /sha256sum --check/);
  assert.match(chemistryWorkflow, /SUPABASE_SERVICE_ROLE_KEY: \$\{\{ secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/);
  assert.doesNotMatch(blueprint, /type: pserv/);
  assert.match(blueprint, /AXIOM_HEAVY_COMPUTE_MODE[\s\S]*github_actions/);
  assert.match(server, /web_plus_github_actions_batch/);
  assert.match(server, /immediateDispatch/);
});

test("Render blueprint declares the Yomexa domain without embedding secrets", () => {
  assert.match(blueprint, /axiom\.yomexa\.xyz/);
  assert.match(blueprint, /healthCheckPath: \/api\/health/);
  assert.equal((blueprint.match(/value: https:\/\/wmctadhdehnlqzltffun\.supabase\.co/g) || []).length, 2);
  assert.doesNotMatch(blueprint, /supabase\.com\/dashboard/);
  for (const secret of ["SUPABASE_SERVICE_ROLE_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
    assert.match(blueprint, new RegExp(`${secret}\\n\\s+sync: false`));
  }
  assert.doesNotMatch(blueprint, /eyJ[A-Za-z0-9_-]{20,}/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const server = await readFile(new URL("../scripts/serve-production.mjs", import.meta.url), "utf8");
const launcher = await readFile(new URL("../scripts/start-production.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../deploy/Dockerfile", import.meta.url), "utf8");
const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");

test("production server serves the SPA and protects computational chemistry", () => {
  assert.match(server, /dist\/client/);
  assert.match(server, /authenticateSupabaseRequest/);
  assert.match(server, /chemistryRoutes/);
  assert.match(server, /targetPath !== "\/health"/);
  assert.match(server, /authentication_required/);
  assert.match(server, /path\.join\(assetRoot, "index\.html"\)/);
});

test("production container co-locates the auditable POC processes", () => {
  for (const processName of ["chemistry_worker.py", "campaign-worker.mjs", "serve-production.mjs"]) assert.match(launcher, new RegExp(processName.replace(".", "\\.")));
  assert.match(dockerfile, /FROM node:22\.19-bookworm-slim AS web-build/);
  assert.match(dockerfile, /FROM python:3\.12-slim AS runtime/);
  assert.match(dockerfile, /requirements-admet\.txt/);
  assert.match(dockerfile, /libxrender1/);
  assert.match(dockerfile, /libxext6/);
  assert.match(dockerfile, /libsm6/);
  assert.match(dockerfile, /start-production\.mjs/);
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

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const project = process.cwd();
const chemistryPythonCandidates = [
  process.env.AXIOM_CHEMISTRY_PYTHON,
  `${project}/.runtime/chemistry/bin/python`,
  `${project}/.venv-admet/bin/python`,
].filter(Boolean);
const chemistryScript = `${project}/services/chemistry_worker.py`;
const viteBin = `${project}/node_modules/vite/bin/vite.js`;
const campaignWorker = `${project}/scripts/campaign-worker.mjs`;
const children = [];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: project, stdio: "inherit", ...options });
  children.push(child);
  return child;
}

function stop(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.once("SIGINT", () => { stop("SIGINT"); process.exit(130); });
process.once("SIGTERM", () => { stop("SIGTERM"); process.exit(143); });
process.once("exit", () => stop());

const chemistryPython = (await Promise.all(chemistryPythonCandidates.map(async (candidate) => await exists(candidate) ? candidate : null))).find(Boolean);

if (chemistryPython && await exists(chemistryScript)) {
  const chemistry = launch(chemistryPython, [chemistryScript], {
    env: {
      ...process.env,
      MPLCONFIGDIR: `${project}/.runtime/matplotlib`,
      AXIOM_CHEMISTRY_PORT: process.env.AXIOM_CHEMISTRY_PORT || "8791",
    },
  });
  chemistry.on("exit", (code) => {
    if (code && code !== 143) console.warn(`Local chemistry worker stopped with exit code ${code}.`);
  });
} else {
  console.warn("Local chemistry environment is not installed; the validation workbench will report its exact setup blocker.");
}

if (await exists(campaignWorker)) {
  const campaign = launch(process.execPath, [campaignWorker]);
  campaign.on("exit", (code) => {
    if (code && code !== 143) console.warn(`Local campaign worker stopped with exit code ${code}.`);
  });
}

const vite = launch(process.execPath, [viteBin, ...process.argv.slice(2)]);
vite.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
});

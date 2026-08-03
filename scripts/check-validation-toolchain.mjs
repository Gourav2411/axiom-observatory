#!/usr/bin/env node
import { accessSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pythonModules = ["rdkit", "openbabel", "deepchem", "chemprop", "aizynthfinder"];
const binaries = ["obabel", "vina", "smina"];

function commandExists(command) {
  const result = spawnSync("command", ["-v", command], { shell: true, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function pythonModuleExists(name, interpreter = "python3") {
  const source = `import importlib.util; raise SystemExit(0 if importlib.util.find_spec(${JSON.stringify(name)}) else 1)`;
  const result = spawnSync(interpreter, ["-c", source], { encoding: "utf8" });
  return result.status === 0;
}

function availableInterpreter(path) {
  try { accessSync(path); return path; } catch { return null; }
}

const interpreters = [
  availableInterpreter(".venv-admet/bin/python"),
  availableInterpreter(".venv/bin/python"),
  "python3",
].filter(Boolean);

function moduleInAnyRuntime(name) {
  return interpreters.some((interpreter) => pythonModuleExists(name, interpreter));
}

const report = {
  python: commandExists("python3"),
  runtimes: interpreters,
  modules: Object.fromEntries(pythonModules.map((name) => [name, moduleInAnyRuntime(name)])),
  binaries: Object.fromEntries(binaries.map((name) => [name, commandExists(name)])),
};

console.log(JSON.stringify(report, null, 2));

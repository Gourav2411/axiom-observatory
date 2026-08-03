import { spawn } from "node:child_process";
import process from "node:process";

const children = [];
const launch = (command, args, env = process.env) => {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  children.push(child);
  return child;
};
const stop = (signal = "SIGTERM") => children.forEach((child) => { if (!child.killed) child.kill(signal); });

process.once("SIGINT", () => { stop("SIGINT"); process.exit(130); });
process.once("SIGTERM", () => { stop("SIGTERM"); process.exit(143); });
process.once("exit", () => stop());

const chemistry = launch(process.env.AXIOM_CHEMISTRY_PYTHON || "python", ["services/chemistry_worker.py"], {
  ...process.env,
  AXIOM_CHEMISTRY_HOST: "127.0.0.1",
  AXIOM_CHEMISTRY_PORT: "8791",
  MPLCONFIGDIR: "/tmp/axiom-matplotlib",
});
const campaign = launch(process.execPath, ["scripts/campaign-worker.mjs"]);
const web = launch(process.execPath, ["scripts/serve-production.mjs"]);

for (const [name, child] of [["chemistry", chemistry], ["campaign", campaign], ["web", web]]) {
  child.on("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") return;
    console.error(`${name} process exited unexpectedly (${code ?? signal}).`);
    stop();
    process.exit(code || 1);
  });
}

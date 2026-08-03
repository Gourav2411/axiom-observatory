#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const runRepository = path.join(root, "worker", "run-repository.js");
const embeddingClient = path.join(root, "worker", "embedding-client.js");
const ragPipeline = path.join(root, "worker", "rag-pipeline.js");
const validationPlan = path.join(root, "worker", "validation-plan.js");
const hosting = path.join(root, ".openai", "hosting.json");

for (const file of [index, worker, runRepository, embeddingClient, ragPipeline, validationPlan, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(runRepository, path.join(dist, "server", "run-repository.js"));
copyFileSync(embeddingClient, path.join(dist, "server", "embedding-client.js"));
copyFileSync(ragPipeline, path.join(dist, "server", "rag-pipeline.js"));
copyFileSync(validationPlan, path.join(dist, "server", "validation-plan.js"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

console.log("Prepared Sites build: server modules and dist/.openai/hosting.json");

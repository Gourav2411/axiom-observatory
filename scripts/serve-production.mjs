import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import worker, { authenticateSupabaseRequest } from "../worker/index.js";

const root = process.cwd();
const assetRoot = path.resolve(root, "dist/client");
const chemistryUrl = (process.env.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
const chemistryRoutes = new Set([
  "GET /health",
  "POST /prepare",
  "POST /admet",
  "POST /applicability/admet",
  "POST /receptors",
  "POST /docking/prepare",
  "POST /docking/run",
  "POST /retrosynthesis/fragments",
  "POST /retrosynthesis/plan",
]);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const cleanOrigin = (value) => value ? value.replace(/\/+$/, "") : "";
const computeOrigin = () => {
  const explicit = cleanOrigin(process.env.AXIOM_COMPUTE_URL || "");
  if (explicit) return explicit;
  const hostport = cleanOrigin(process.env.AXIOM_COMPUTE_HOSTPORT || "");
  return hostport ? `http://${hostport}` : "";
};

function chemistryTarget(targetPath) {
  const compute = computeOrigin();
  if (compute && ["/admet", "/applicability/admet", "/receptors", "/docking/run"].includes(targetPath)) return compute;
  return chemistryUrl;
}

function internalHeaders(origin) {
  const key = process.env.AXIOM_INTERNAL_WORKER_KEY || "";
  return origin === computeOrigin() && key ? { "x-axiom-worker-key": key } : {};
}

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function assetFetch(request) {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(assetRoot, `.${pathname}`);
  if (filePath !== assetRoot && !filePath.startsWith(`${assetRoot}${path.sep}`)) return new Response("Not found", { status: 404 });

  const serveFile = async (candidate, cacheControl) => {
    const fileStat = await stat(candidate);
    if (!fileStat.isFile()) return null;
    const bytes = await readFile(candidate);
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": mimeTypes[path.extname(candidate).toLowerCase()] || "application/octet-stream",
        "cache-control": cacheControl,
      },
    });
  };

  try {
    const asset = await serveFile(filePath, pathname === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable");
    if (asset) return asset;
  } catch {}

  // Browser routes such as /auth/callback and /reset-password must survive a
  // direct navigation so the client can finish Supabase authentication flows.
  if (!path.extname(pathname)) {
    try {
      return await serveFile(path.join(assetRoot, "index.html"), "no-cache");
    } catch {}
  }
  return new Response("Not found", { status: 404 });
}

function runtimeEnv() {
  const local = chemistryUrl;
  const compute = computeOrigin();
  return {
    APP_ENV: "production",
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    AXIOM_RDKIT_WORKER_URL: process.env.AXIOM_RDKIT_WORKER_URL || `${local}/prepare`,
    AXIOM_ADMET_WORKER_URL: process.env.AXIOM_ADMET_WORKER_URL || `${compute || local}/admet`,
    AXIOM_DOCKING_WORKER_URL: process.env.AXIOM_DOCKING_WORKER_URL || `${compute || local}/${compute ? "docking/run" : "docking/prepare"}`,
    AXIOM_DOCKING_EXECUTION_MODE: compute ? "vina_scoring" : "preparation_only",
    AXIOM_HEAVY_COMPUTE_MODE: process.env.AXIOM_HEAVY_COMPUTE_MODE,
    AXIOM_RETROSYNTHESIS_WORKER_URL: process.env.AXIOM_RETROSYNTHESIS_WORKER_URL || `${local}/retrosynthesis/fragments`,
    AXIOM_PBPK_URL: process.env.AXIOM_PBPK_URL,
    AXIOM_POPPK_URL: process.env.AXIOM_POPPK_URL,
    AXIOM_TRIAL_SIMULATION_URL: process.env.AXIOM_TRIAL_SIMULATION_URL,
    GITHUB_ACTIONS_TOKEN: process.env.GITHUB_ACTIONS_TOKEN,
    GITHUB_ACTIONS_REPOSITORY: process.env.GITHUB_ACTIONS_REPOSITORY,
    GITHUB_ACTIONS_REF: process.env.GITHUB_ACTIONS_REF,
    ASSETS: { fetch: assetFetch },
  };
}

async function proxyChemistry(request, body) {
  const incoming = new URL(request.url);
  const targetPath = incoming.pathname.replace(/^\/api\/chemistry/, "") || "/health";
  if (!chemistryRoutes.has(`${request.method} ${targetPath}`)) return jsonError("chemistry_route_not_found", "Chemistry route is unavailable", 404);
  if (targetPath !== "/health") {
    try {
      await authenticateSupabaseRequest(request, runtimeEnv());
    } catch {
      return jsonError("authentication_required", "Sign in with Supabase to run chemistry computations", 401);
    }
  }
  try {
    if (targetPath === "/health" && process.env.AXIOM_HEAVY_COMPUTE_MODE === "github_actions" && !computeOrigin()) {
      const localResponse = await fetch(`${chemistryUrl}/health`, { signal: AbortSignal.timeout(15_000) });
      const local = await localResponse.json();
      return new Response(JSON.stringify({
        ...local,
        topology: "web_plus_github_actions_batch",
        batchCompute: { status: "configured", provider: "GitHub Actions", execution: "asynchronous_batched" },
        capabilities: {
          ...local.capabilities,
          admet: { ...local.capabilities?.admet, batchAvailable: true, batchProvider: "GitHub Actions", reason: "ADMET-AI runs asynchronously in queued campaign batches." },
          docking: { ...local.capabilities?.docking, batchAvailable: true, batchProvider: "GitHub Actions", reason: "AutoDock Vina scoring runs asynchronously in queued campaign batches when a versioned receptor is available." },
        },
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (targetPath === "/health" && computeOrigin()) {
      const [localResponse, computeResponse] = await Promise.all([
        fetch(`${chemistryUrl}/health`, { signal: AbortSignal.timeout(15_000) }),
        fetch(`${computeOrigin()}/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => null),
      ]);
      const local = await localResponse.json();
      const compute = computeResponse?.ok ? await computeResponse.json() : null;
      return new Response(JSON.stringify({
        ...local,
        topology: "web_plus_private_compute",
        compute: compute ? { status: compute.status, service: compute.service } : { status: "unavailable" },
        capabilities: {
          ...local.capabilities,
          admet: compute?.capabilities?.admet || local.capabilities?.admet,
          docking: compute?.capabilities?.docking || local.capabilities?.docking,
        },
      }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const origin = chemistryTarget(targetPath);
    return await fetch(`${origin}${targetPath}${incoming.search}`, {
      method: request.method,
      headers: { accept: "application/json", ...(request.headers.get("content-type") ? { "content-type": request.headers.get("content-type") } : {}), ...internalHeaders(origin) },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
      signal: AbortSignal.timeout(15 * 60_000),
    });
  } catch {
    return jsonError("chemistry_worker_unavailable", "The chemistry worker is unavailable", 503);
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const origin = `http://${incoming.headers.host || "localhost"}`;
    const request = new Request(new URL(incoming.url || "/", origin), {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method || "GET") ? undefined : body,
    });
    const response = request.url.includes("/api/chemistry/")
      ? await proxyChemistry(request, body)
      : await worker.fetch(request, runtimeEnv());
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Production request failed:", error.message);
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: { code: "production_server_failure", message: "The request could not be completed" } }));
  }
});

server.listen(port, host, () => console.log(`Axiom production server listening on ${host}:${port}`));

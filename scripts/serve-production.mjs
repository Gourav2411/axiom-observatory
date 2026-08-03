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
  return {
    APP_ENV: "production",
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    AXIOM_RDKIT_WORKER_URL: process.env.AXIOM_RDKIT_WORKER_URL || `${local}/prepare`,
    AXIOM_ADMET_WORKER_URL: process.env.AXIOM_ADMET_WORKER_URL || `${local}/admet`,
    AXIOM_DOCKING_WORKER_URL: process.env.AXIOM_DOCKING_WORKER_URL || `${local}/docking/prepare`,
    AXIOM_RETROSYNTHESIS_WORKER_URL: process.env.AXIOM_RETROSYNTHESIS_WORKER_URL || `${local}/retrosynthesis/fragments`,
    AXIOM_PBPK_URL: process.env.AXIOM_PBPK_URL,
    AXIOM_POPPK_URL: process.env.AXIOM_POPPK_URL,
    AXIOM_TRIAL_SIMULATION_URL: process.env.AXIOM_TRIAL_SIMULATION_URL,
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
    return await fetch(`${chemistryUrl}${targetPath}${incoming.search}`, {
      method: request.method,
      headers: { accept: "application/json", ...(request.headers.get("content-type") ? { "content-type": request.headers.get("content-type") } : {}) },
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

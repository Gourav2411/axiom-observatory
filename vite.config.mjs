import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import worker from "./worker/index.js";

function localWorkerApi(runtimeEnv) {
  return {
    name: "axiom-local-worker-api",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        if (!incoming.url?.startsWith("/api/")) return next();

        try {
          const chunks = [];
          for await (const chunk of incoming) chunks.push(chunk);
          const body = chunks.length ? Buffer.concat(chunks) : undefined;
          const origin = `http://${incoming.headers.host ?? "localhost"}`;
          const request = new Request(new URL(incoming.url, origin), {
            method: incoming.method,
            headers: incoming.headers,
            body: ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : body,
          });
          let response;
          if (incoming.url.startsWith("/api/chemistry/")) {
            const chemistryUrl = new URL(incoming.url.replace(/^\/api\/chemistry/, ""), runtimeEnv.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791");
            try {
              response = await fetch(chemistryUrl, {
                method: request.method,
                headers: request.headers,
                body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
                signal: AbortSignal.timeout(180_000),
              });
            } catch (error) {
              response = new Response(JSON.stringify({
                error: {
                  code: "chemistry_worker_unavailable",
                  message: "The local chemistry worker is not running.",
                  details: error.message,
                },
              }), { status: 503, headers: { "content-type": "application/json" } });
            }
          } else {
            const localChemistryUrl = runtimeEnv.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791";
            response = await worker.fetch(request, {
              APP_ENV: "local",
              SUPABASE_URL: runtimeEnv.SUPABASE_URL,
              SUPABASE_SERVICE_ROLE_KEY: runtimeEnv.SUPABASE_SERVICE_ROLE_KEY,
              AXIOM_RDKIT_WORKER_URL: runtimeEnv.AXIOM_RDKIT_WORKER_URL || `${localChemistryUrl}/prepare`,
              AXIOM_ADMET_WORKER_URL: runtimeEnv.AXIOM_ADMET_WORKER_URL || `${localChemistryUrl}/admet`,
              AXIOM_DOCKING_WORKER_URL: runtimeEnv.AXIOM_DOCKING_WORKER_URL || `${localChemistryUrl}/docking/prepare`,
              AXIOM_RETROSYNTHESIS_WORKER_URL: runtimeEnv.AXIOM_RETROSYNTHESIS_WORKER_URL || `${localChemistryUrl}/retrosynthesis/fragments`,
              ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
            });
          }

          outgoing.statusCode = response.status;
          response.headers.forEach((value, name) => outgoing.setHeader(name, value));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          server.config.logger.error(error);
          outgoing.statusCode = 500;
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ error: "local_api_failure", message: error.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const runtimeEnv = loadEnv(mode, process.cwd(), "");
  return {
    build: {
      outDir: "dist/client",
    },
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [react(), localWorkerApi(runtimeEnv)],
  };
});

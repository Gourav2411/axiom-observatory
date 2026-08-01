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
          const response = await worker.fetch(request, {
            APP_ENV: "local",
            SUPABASE_URL: runtimeEnv.SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: runtimeEnv.SUPABASE_SERVICE_ROLE_KEY,
            ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
          });

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

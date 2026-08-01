const RUN_SNAPSHOTS_TABLE = "run_snapshots";
const SUPABASE_TIMEOUT_MS = 8_000;

class PersistenceError extends Error {
  constructor(message, { operation, status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PersistenceError";
    this.operation = operation;
    this.status = status;
  }
}

const memorySnapshots = new Map();

function persistenceState(mode, durable, configured, available) {
  return { mode, durable, configured, available };
}

function memoryRepository() {
  const persistence = persistenceState("ephemeral_memory", false, false, true);
  return {
    persistence,
    async prepare() {
      return null;
    },
    async health() {
      return persistence;
    },
    async put(run) {
      memorySnapshots.set(run.id, structuredClone(run));
      return run;
    },
    async get(id) {
      const run = memorySnapshots.get(id);
      return run ? structuredClone(run) : null;
    },
  };
}

function unavailableRepository(reason, configured = false) {
  const persistence = persistenceState("supabase_postgres", false, configured, false);
  const fail = async (operation) => {
    throw new PersistenceError(reason, { operation });
  };
  return {
    persistence,
    prepare: () => fail("configure"),
    async health() {
      return persistence;
    },
    put: () => fail("write"),
    get: () => fail("read"),
  };
}

function supabaseHeaders(serviceRoleKey, write = false, accessToken = serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "accept-profile": "public",
    ...(write ? {
      "content-profile": "public",
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    } : {}),
  };
}

async function fetchWithPersistenceTimeout(transport, input, init, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    return await transport(input, { ...init, signal: controller.signal });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    throw new PersistenceError(
      timeout ? "Durable run storage timed out" : "Durable run storage is unavailable",
      { operation, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

function runToSnapshotRow(run, { workspaceId = null, userId = null } = {}) {
  return {
    id: run.id,
    workspace_id: workspaceId,
    created_by: userId,
    schema_version: run.schemaVersion ?? null,
    status: run.status ?? null,
    target_id: run.target?.id ?? null,
    disease_id: run.disease?.id ?? null,
    created_at: run.createdAt ?? new Date().toISOString(),
    updated_at: run.updatedAt ?? new Date().toISOString(),
    snapshot: run,
  };
}

function supabaseRepository({ supabaseUrl, serviceRoleKey, transport, principal = null }) {
  let endpoint;
  let workspaceEndpoint;
  try {
    endpoint = new URL(`/rest/v1/${RUN_SNAPSHOTS_TABLE}`, `${supabaseUrl.replace(/\/+$/, "")}/`);
    workspaceEndpoint = new URL("/rest/v1/rpc/ensure_default_workspace", `${supabaseUrl.replace(/\/+$/, "")}/`);
  } catch (error) {
    return unavailableRepository("Supabase persistence URL is invalid", true);
  }

  const persistence = persistenceState("supabase_postgres", true, true, true);
  let resolvedWorkspaceId = null;

  async function ensureWorkspace() {
    if (resolvedWorkspaceId) return resolvedWorkspaceId;
    if (!principal?.accessToken || !principal?.userId) {
      throw new PersistenceError("An authenticated Supabase context is required", { operation: "authorize" });
    }
    const response = await fetchWithPersistenceTimeout(transport, workspaceEndpoint, {
      method: "POST",
      headers: supabaseHeaders(serviceRoleKey, true, principal.accessToken),
      body: "{}",
    }, "workspace");
    if (!response.ok) {
      throw new PersistenceError("The user workspace could not be resolved", {
        operation: "workspace",
        status: response.status,
      });
    }
    try {
      resolvedWorkspaceId = await response.json();
    } catch (error) {
      throw new PersistenceError("The workspace resolver returned an invalid response", {
        operation: "workspace",
        status: response.status,
        cause: error,
      });
    }
    if (typeof resolvedWorkspaceId !== "string" || !/^[0-9a-f-]{36}$/i.test(resolvedWorkspaceId)) {
      throw new PersistenceError("The workspace resolver returned an invalid identifier", {
        operation: "workspace",
        status: response.status,
      });
    }
    return resolvedWorkspaceId;
  }

  return {
    persistence,
    async prepare() {
      return {
        workspaceId: await ensureWorkspace(),
        createdBy: principal.userId,
      };
    },
    async health() {
      const url = new URL(endpoint);
      url.searchParams.set("select", "id");
      url.searchParams.set("limit", "1");
      try {
        const response = await fetchWithPersistenceTimeout(transport, url, {
          method: "GET",
          headers: supabaseHeaders(serviceRoleKey),
        }, "health");
        return { ...persistence, durable: response.ok, available: response.ok };
      } catch {
        return { ...persistence, durable: false, available: false };
      }
    },
    async put(run) {
      const workspaceId = await ensureWorkspace();
      const ownedRun = {
        ...run,
        workspaceId,
        createdBy: principal.userId,
      };
      const url = new URL(endpoint);
      url.searchParams.set("on_conflict", "id");
      const response = await fetchWithPersistenceTimeout(transport, url, {
        method: "POST",
        headers: supabaseHeaders(serviceRoleKey, true, principal.accessToken),
        body: JSON.stringify(runToSnapshotRow(ownedRun, { workspaceId, userId: principal.userId })),
      }, "write");
      if (!response.ok) {
        throw new PersistenceError("Durable run storage rejected the write", {
          operation: "write",
          status: response.status,
        });
      }
      return ownedRun;
    },
    async get(id) {
      if (!principal?.accessToken) {
        throw new PersistenceError("An authenticated Supabase context is required", { operation: "authorize" });
      }
      const url = new URL(endpoint);
      url.searchParams.set("id", `eq.${id}`);
      url.searchParams.set("select", "snapshot");
      url.searchParams.set("limit", "1");
      const response = await fetchWithPersistenceTimeout(transport, url, {
        method: "GET",
        headers: supabaseHeaders(serviceRoleKey, false, principal.accessToken),
      }, "read");
      if (!response.ok) {
        throw new PersistenceError("Durable run storage rejected the read", {
          operation: "read",
          status: response.status,
        });
      }
      let rows;
      try {
        rows = await response.json();
      } catch (error) {
        throw new PersistenceError("Durable run storage returned an invalid response", {
          operation: "read",
          status: response.status,
          cause: error,
        });
      }
      if (!Array.isArray(rows) || !rows.length) return null;
      const snapshot = rows[0]?.snapshot;
      return snapshot && typeof snapshot === "object" ? snapshot : null;
    },
  };
}

function createRunRepository(env = {}, principal = null) {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const serviceRoleKey = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string"
    ? env.SUPABASE_SERVICE_ROLE_KEY.trim()
    : "";

  if (!supabaseUrl && !serviceRoleKey) return memoryRepository();
  if (!supabaseUrl || !serviceRoleKey) {
    return unavailableRepository("Supabase persistence configuration is incomplete");
  }

  const transport = env.SUPABASE_FETCH ?? env.PERSISTENCE_FETCH ?? globalThis.fetch;
  if (typeof transport !== "function") {
    return unavailableRepository("Supabase persistence transport is unavailable");
  }
  return supabaseRepository({ supabaseUrl, serviceRoleKey, transport, principal });
}

export {
  PersistenceError,
  RUN_SNAPSHOTS_TABLE,
  createRunRepository,
  runToSnapshotRow,
};

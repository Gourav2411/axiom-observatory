function normalizeSupabaseProjectUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "";

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("SUPABASE_URL must be a valid project API URL such as https://<project-ref>.supabase.co.");
  }

  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const isDashboard = ["supabase.com", "www.supabase.com"].includes(parsed.hostname) || parsed.pathname.startsWith("/dashboard");
  if (isDashboard) {
    throw new Error("SUPABASE_URL points to the Supabase Dashboard. Use the Project URL from Project Settings → API instead.");
  }
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error("SUPABASE_URL must use HTTPS; HTTP is accepted only for local Supabase development.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new Error("SUPABASE_URL must be the project API origin without credentials, a dashboard path, query, or fragment.");
  }
  return parsed.origin;
}

function boundedWorkerError(error) {
  const message = String(error?.message || error || "Unknown worker error");
  if (/<!doctype\s+html|<html[\s>]/i.test(message)) {
    return "Supabase returned an HTML page instead of its JSON API. Verify SUPABASE_URL is the Project URL, not a dashboard URL.";
  }
  return message.replace(/\s+/g, " ").slice(0, 500);
}

export { boundedWorkerError, normalizeSupabaseProjectUrl };

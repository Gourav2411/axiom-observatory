const endpoint = process.env.AXIOM_CHEMISTRY_URL || "http://127.0.0.1:8791";

try {
  const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "unavailable",
    endpoint,
    reason: error.message,
  }, null, 2));
  process.exitCode = 1;
}

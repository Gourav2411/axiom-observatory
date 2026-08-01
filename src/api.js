async function request(path, options = {}) {
  const { accessToken, ...fetchOptions } = options;
  const response = await fetch(path, {
    ...fetchOptions,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.code = payload?.error?.code ?? "request_failed";
    error.status = response.status;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request("/api/health"),
  searchTargets: (query) => request(`/api/targets/search?q=${encodeURIComponent(query)}`),
  searchDiseases: (query) => request(`/api/diseases/search?q=${encodeURIComponent(query)}`),
  createRun: (input, accessToken) => request("/api/runs", { method: "POST", body: JSON.stringify(input), accessToken }),
  getRun: (id, accessToken) => request(`/api/runs/${encodeURIComponent(id)}`, { accessToken }),
  retrieveRun: (id, input, accessToken) => request(`/api/runs/${encodeURIComponent(id)}/retrieval`, {
    method: "POST",
    body: JSON.stringify(input),
    accessToken,
  }),
};

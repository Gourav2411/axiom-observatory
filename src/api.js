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
    const message = payload?.error?.message ?? payload?.detail ?? `Request failed with HTTP ${response.status}`;
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
  searchTargetDiseases: (targetId, query = "") => request(`/api/targets/${encodeURIComponent(targetId)}/diseases?q=${encodeURIComponent(query)}`),
  createRun: (input, accessToken) => request("/api/runs", { method: "POST", body: JSON.stringify(input), accessToken }),
  getRun: (id, accessToken) => request(`/api/runs/${encodeURIComponent(id)}`, { accessToken }),
  listCampaigns: (id, accessToken) => request(`/api/runs/${encodeURIComponent(id)}/campaigns`, { accessToken }),
  createCampaign: (id, input, accessToken) => request(`/api/runs/${encodeURIComponent(id)}/campaigns`, { method: "POST", body: JSON.stringify(input), accessToken }),
  addCampaignCandidate: (id, input, accessToken) => request(`/api/campaigns/${encodeURIComponent(id)}/candidates`, { method: "POST", body: JSON.stringify(input), accessToken }),
  queueCandidate: (id, accessToken) => request(`/api/candidates/${encodeURIComponent(id)}/queue`, { method: "POST", body: "{}", accessToken }),
  reviewCandidate: (id, input, accessToken) => request(`/api/candidates/${encodeURIComponent(id)}/reviews`, { method: "POST", body: JSON.stringify(input), accessToken }),
  ingestAssay: (id, input, accessToken) => request(`/api/candidates/${encodeURIComponent(id)}/assays`, { method: "POST", body: JSON.stringify(input), accessToken }),
  registerTranslationInput: (id, input, accessToken) => request(`/api/candidates/${encodeURIComponent(id)}/translation-inputs`, { method: "POST", body: JSON.stringify(input), accessToken }),
  reviewTranslationInput: (id, input, accessToken) => request(`/api/translation-inputs/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify(input), accessToken }),
  getValidationPlan: (id, accessToken) => request(`/api/runs/${encodeURIComponent(id)}/validation-plan`, { accessToken }),
  chemistryHealth: () => request("/api/chemistry/health"),
  prepareMolecule: (input, accessToken) => request("/api/chemistry/prepare", { method: "POST", body: JSON.stringify(input), accessToken }),
  predictAdmet: (smiles, accessToken) => request("/api/chemistry/admet", { method: "POST", body: JSON.stringify({ smiles }), accessToken }),
  prepareDocking: (input, accessToken) => request("/api/chemistry/docking/prepare", { method: "POST", body: JSON.stringify(input), accessToken }),
  registerReceptor: (input, accessToken) => request("/api/chemistry/receptors", { method: "POST", body: JSON.stringify(input), accessToken }),
  runDocking: (input, accessToken) => request("/api/chemistry/docking/run", { method: "POST", body: JSON.stringify(input), accessToken }),
  fragmentRetrosynthesis: (smiles, accessToken) => request("/api/chemistry/retrosynthesis/fragments", { method: "POST", body: JSON.stringify({ smiles }), accessToken }),
  retrieveRun: (id, input, accessToken) => request(`/api/runs/${encodeURIComponent(id)}/retrieval`, {
    method: "POST",
    body: JSON.stringify(input),
    accessToken,
  }),
};

import { PersistenceError } from "./run-repository.js";

const CAMPAIGN_TIMEOUT_MS = 12_000;

function headers(serviceRoleKey, accessToken, write = false) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "accept-profile": "public",
    ...(write ? {
      "content-profile": "public",
      "content-type": "application/json",
      prefer: "return=representation",
    } : {}),
  };
}

async function request(transport, url, init, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAMPAIGN_TIMEOUT_MS);
  let response;
  try {
    response = await transport(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new PersistenceError("Campaign storage is unavailable", { operation, cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new PersistenceError("Campaign storage rejected the request", { operation, status: response.status });
  }
  const payload = await response.json().catch(() => null);
  if (payload === null) throw new PersistenceError("Campaign storage returned an invalid response", { operation, status: response.status });
  return payload;
}

function endpoint(supabaseUrl, path) {
  return new URL(path, `${supabaseUrl.replace(/\/+$/, "")}/`);
}

function createCampaignRepository(env, principal) {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const transport = env.SUPABASE_FETCH ?? globalThis.fetch;
  if (!supabaseUrl || !serviceRoleKey || !principal?.accessToken) {
    throw new PersistenceError("Campaign storage is not configured", { operation: "campaign_configure" });
  }
  const authHeaders = headers(serviceRoleKey, principal.accessToken);
  const writeHeaders = headers(serviceRoleKey, principal.accessToken, true);

  async function table(name, query, operation) {
    const url = endpoint(supabaseUrl, `/rest/v1/${name}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return request(transport, url, { method: "GET", headers: authHeaders }, operation);
  }

  async function rpc(name, body, operation) {
    return request(transport, endpoint(supabaseUrl, `/rest/v1/rpc/${name}`), {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(body),
    }, operation);
  }

  return {
    async list(runId) {
      const campaigns = await table("campaigns", {
        run_id: `eq.${runId}`,
        select: "*",
        order: "created_at.desc",
      }, "campaign_list");
      if (!campaigns.length) return [];
      const campaignIds = campaigns.map((item) => item.id).join(",");
      const [candidates, evaluations, reviews, jobs] = await Promise.all([
        table("campaign_candidates", { campaign_id: `in.(${campaignIds})`, select: "*", order: "rank_score.desc.nullslast,created_at.asc" }, "candidate_list"),
        table("candidate_evaluations", { run_id: `eq.${runId}`, select: "*", order: "created_at.asc" }, "evaluation_list"),
        table("scientific_reviews", { run_id: `eq.${runId}`, select: "*", order: "created_at.desc" }, "review_list"),
        table("jobs", { run_id: `eq.${runId}`, select: "id,job_type,status,attempts,max_attempts,payload,result,error,created_at,updated_at", order: "created_at.desc" }, "campaign_job_list"),
      ]);
      return campaigns.map((campaign) => ({
        ...campaign,
        candidates: candidates.filter((candidate) => candidate.campaign_id === campaign.id).map((candidate) => ({
          ...candidate,
          evaluations: evaluations.filter((evaluation) => evaluation.candidate_id === candidate.id),
          reviews: reviews.filter((review) => review.candidate_id === candidate.id),
          jobs: jobs.filter((job) => job.payload?.candidateId === candidate.id),
        })),
      }));
    },
    create(runId, input) {
      return rpc("create_campaign_v1", {
        p_run_id: runId,
        p_name: input.name,
        p_objective: input.objective ?? "",
        p_settings: input.settings ?? {},
      }, "campaign_create");
    },
    addCandidate(campaignId, input) {
      return rpc("add_campaign_candidate_v1", {
        p_campaign_id: campaignId,
        p_name: input.name,
        p_smiles: input.smiles,
      }, "candidate_create");
    },
    queueCandidate(candidateId) {
      return rpc("queue_candidate_workflow_v1", { p_candidate_id: candidateId }, "candidate_queue");
    },
    reviewCandidate(candidateId, input) {
      return rpc("submit_scientific_review_v1", {
        p_candidate_id: candidateId,
        p_decision: input.decision,
        p_rationale: input.rationale,
      }, "candidate_review");
    },
  };
}

export { createCampaignRepository };

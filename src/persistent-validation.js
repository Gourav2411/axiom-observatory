const ACTIVE_JOB_STATUSES = new Set(["queued", "leased", "running"]);

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestAdmetJob(candidate) {
  return (candidate.jobs ?? [])
    .filter((job) => job.job_type === "admet")
    .sort((left, right) => timestamp(right.updated_at ?? right.created_at) - timestamp(left.updated_at ?? left.created_at))[0] ?? null;
}

export function persistentAdmetState(campaigns, candidateId = null) {
  const candidates = (campaigns ?? [])
    .filter((campaign) => campaign.settings?.source === "validation_workbench")
    .flatMap((campaign) => campaign.candidates ?? [])
    .filter((candidate) => !candidateId || candidate.id === candidateId)
    .map((candidate) => ({ candidate, job: newestAdmetJob(candidate) }))
    .filter(({ job }) => Boolean(job))
    .sort((left, right) => timestamp(right.job.updated_at ?? right.job.created_at) - timestamp(left.job.updated_at ?? left.job.created_at));

  const latest = candidates[0];
  if (!latest) return null;

  const evaluation = (latest.candidate.evaluations ?? []).find((item) => item.evaluation_type === "admet");
  const result = evaluation?.status === "completed" && evaluation.result
    ? evaluation.result
    : latest.job.status === "succeeded" && latest.job.result
      ? latest.job.result
      : null;
  const status = result ? "succeeded" : latest.job.status;

  return {
    queue: {
      candidateId: latest.candidate.id,
      jobId: latest.job.id,
      status,
      error: latest.job.error?.message ?? null,
      compute: {
        status: "restored",
        reason: ACTIVE_JOB_STATUSES.has(status)
          ? "Durable Supabase job restored; updates will continue automatically."
          : "Durable Supabase result restored.",
      },
    },
    result,
    smiles: latest.candidate.canonical_smiles ?? latest.candidate.input_smiles ?? null,
  };
}

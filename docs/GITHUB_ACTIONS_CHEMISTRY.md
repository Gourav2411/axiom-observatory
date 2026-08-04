# Zero-fixed-cost chemistry compute

## Runtime split

The existing Render service runs the SPA, API, Supabase campaign poller, RDKit preparation, Meeko ligand preparation, and BRICS fragment analysis. It leases only lightweight job types.

ADMET-AI and AutoDock Vina jobs remain queued until `.github/workflows/chemistry-compute.yml` starts. The workflow first checks Supabase for heavy jobs on a small runner. It installs the chemistry runtime only when work exists, then leases up to 20 ADMET or docking jobs on an 8 GB GitHub-hosted runner. The hourly schedule is a recovery path; queueing a candidate also requests an immediate workflow dispatch when Render has a GitHub Actions token.

Results use the existing `complete_campaign_job_v1` contract. Content-addressed artifacts and a signed job manifest are uploaded into the private `run-artifacts` Supabase bucket before the job is completed.

## Required GitHub repository secrets

Configure these under **GitHub repository → Settings → Secrets and variables → Actions**:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`AXIOM_ARTIFACT_SIGNING_KEY` is optional. Until the same key is deliberately configured in Render and GitHub, GitHub-compute manifests are truthfully marked `unsigned_no_signing_key`.

The service-role key is used only by the private workflow to lease and complete jobs. The workflow has repository `contents: read` permission and never prints secret values.

## Optional immediate dispatch

Create a fine-grained GitHub token restricted to `Gourav2411/axiom-observatory` with **Actions: Read and write**. Store it in Render as `GITHUB_ACTIONS_TOKEN`. The Blueprint provides `GITHUB_ACTIONS_REPOSITORY` and `GITHUB_ACTIONS_REF`.

This credential is required for the Validation workbench's **Run ADMET asynchronously** button to dispatch immediately. Without it, the durable Supabase job remains safe and the hourly workflow schedule will pick it up, but the UI will truthfully report `scheduled_fallback` instead of claiming an immediate run.

If this token is absent or dispatch fails, the job stays queued and the hourly workflow schedule processes it later. The API reports `scheduled_fallback` rather than losing the job.

## Database migration

Apply `20260804090000_scoped_campaign_leasing.sql`. It introduces `lease_campaign_jobs_v2`, which accepts an explicit allowlist of job types. Render leases lightweight jobs; GitHub Actions leases only `admet` and `docking_score`. PostgreSQL row locking prevents the two workers from taking the same job.

## Docking receptors

GitHub Actions checks out the private repository for every batch. A receptor used by a campaign must therefore be a reviewed PDBQT file under `services/receptors/`, and the campaign's `receptorPath` must be its relative file name. This makes the receptor versioned and reproducible.

The workflow runs three deterministic Vina seed replicates by default and supports a known-ligand same-box score control. This is computational prioritization, not experimental binding evidence or crystallographic RMSD redocking validation.

## Cost and quota behavior

No additional Render service is created. Private-repository GitHub Actions usage consumes the repository owner's included monthly minutes. Configure a zero spending budget so execution stops when the included quota is exhausted. Batch multiple candidates together to amortize environment setup and model loading.

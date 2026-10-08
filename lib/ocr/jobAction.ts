// Pure idempotency decision (dependency-free so it is unit-testable in isolation).
// Repeated clicks / refreshes / retries must not create duplicate active jobs, and
// a completed result is reused unless reprocessing is explicitly requested.
export type JobAction = "reuse" | "attach" | "create";

export function resolveJobAction(input: { hasCompletedResult: boolean; activeJobId: string | null; force: boolean }): JobAction {
  if (input.force) return "create"; // explicit reprocess always creates fresh work
  if (input.hasCompletedResult) return "reuse"; // completed result → no new work
  if (input.activeJobId) return "attach"; // in-flight job → attach, never duplicate
  return "create";
}

// A queued/running job whose serverless worker died leaves a stuck row. After
// this age it is considered stale and reclaimed (marked failed) so a fresh job
// can run. 10 min comfortably exceeds the worst-case OCR budget (120s) + retries.
export const STALE_JOB_MS = 10 * 60 * 1000;

export function isStaleJob(input: { status: string; updatedAt: string | null | undefined; nowMs: number; staleMs?: number }): boolean {
  if (input.status !== "running" && input.status !== "queued") return false;
  const updated = input.updatedAt ? Date.parse(input.updatedAt) : NaN;
  if (!Number.isFinite(updated)) return false;
  return input.nowMs - updated > (input.staleMs ?? STALE_JOB_MS);
}

/**
 * Whether POST /api/jobs/process may try to claim this job. A queued job is
 * claimable; a running job belongs to the request already working on it unless
 * it has gone stale (its worker died). The UI polls /api/jobs/process every
 * 2.5 s per active document, and re-running "running" jobs is what wrote up to
 * five OCR results for one document within 0.3 s (release audit, 2026-10-08).
 * The claim itself is a conditional update, so two callers that both see a job
 * as claimable cannot both win it.
 */
export function isClaimable(job: { status: string; updatedAt: string | null | undefined }, nowMs: number): boolean {
  if (job.status === "queued") return true;
  if (job.status === "running") return isStaleJob({ status: job.status, updatedAt: job.updatedAt, nowMs });
  return false;
}

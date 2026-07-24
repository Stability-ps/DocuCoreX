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

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

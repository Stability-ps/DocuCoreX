import type { AccountingRunStatus } from "@/lib/accounting/types";

// Terminal run states — polling stops and the UI shows a final status here.
const TERMINAL_STATUSES: AccountingRunStatus[] = ["completed", "failed", "review", "cancelled"];

export function isTerminalRunStatus(status: AccountingRunStatus | null | undefined): boolean {
  return Boolean(status) && TERMINAL_STATUSES.includes(status as AccountingRunStatus);
}

// Signals used to decide a run has really finished even if its status row still
// reads "processing" for a moment (the worker writes transactions/validation
// before the status flip, or the status update lagged).
export type RunStatusSignals = {
  status?: AccountingRunStatus | null;
  transactionCount?: number | null;
  requiresReview?: boolean | null;
  validationStatus?: string | null;
};

// Derive the status the UI should show. A run must NOT keep showing "Processing"
// once any of these hold (status-sync Req 4):
//   • transactionCount > 0
//   • requiresReview === true
//   • validationStatus is failed / review / completed
// Returns null when the run is genuinely still processing/queued.
export function deriveEffectiveRunStatus(run: RunStatusSignals, transactionCount?: number): AccountingRunStatus | null {
  const status = run.status ?? null;
  if (isTerminalRunStatus(status)) return status;

  const vs = (run.validationStatus ?? "").toLowerCase();
  const txCount = transactionCount ?? run.transactionCount ?? 0;

  if (vs === "failed") return "failed";
  if (run.requiresReview === true || vs === "review" || vs === "review_required") return "review";
  if (txCount > 0 || vs === "valid" || vs === "completed") return "completed";

  return status; // still genuinely processing / queued
}

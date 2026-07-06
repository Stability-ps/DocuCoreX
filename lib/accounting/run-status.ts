import type { AccountingRunStatus } from "@/lib/accounting/types";

// Terminal run states — polling stops and the UI shows a final status here.
const TERMINAL_STATUSES: AccountingRunStatus[] = ["completed", "failed", "review", "cancelled"];
const ACTIVE_STATUSES = new Set(["queued", "processing", "pending"]);

export function normalizeRunStatus(status: string | null | undefined): AccountingRunStatus | "pending" | "error" | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "pending") return "pending";
  if (normalized === "queued" || normalized === "processing" || normalized === "review" || normalized === "completed" || normalized === "failed" || normalized === "cancelled") {
    return normalized;
  }
  return null;
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === "error" || (Boolean(normalized) && TERMINAL_STATUSES.includes(normalized as AccountingRunStatus));
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  const normalized = normalizeRunStatus(status);
  return typeof normalized === "string" && ACTIVE_STATUSES.has(normalized);
}

// Signals used to decide a run has really finished even if its status row still
// reads "processing" for a moment (the worker writes transactions/validation
// before the status flip, or the status update lagged).
export type RunStatusSignals = {
  status?: AccountingRunStatus | "pending" | "error" | null;
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
  const status = normalizeRunStatus(run.status ?? null);
  if (status === "error") return "failed";
  if (status === "pending") return "processing";
  if (isTerminalRunStatus(status)) return status;

  const vs = (run.validationStatus ?? "").toLowerCase();
  const txCount = transactionCount ?? run.transactionCount ?? 0;

  if (vs === "failed") return "failed";
  if (run.requiresReview === true || vs === "review" || vs === "review_required") return "review";
  if (txCount > 0 || vs === "valid" || vs === "completed") return "completed";

  return status; // still genuinely processing / queued
}

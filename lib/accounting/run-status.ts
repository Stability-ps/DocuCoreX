import type { AccountingRunStatus } from "@/lib/accounting/types";

// Terminal run states — polling stops and the UI shows a final status here.
const TERMINAL_STATUSES: AccountingRunStatus[] = ["completed", "failed", "review", "cancelled"];
const ACTIVE_STATUSES = new Set(["queued", "processing", "pending"]);

// No progress for this long after acceptance and the run is reported stalled.
// Generous on purpose: a large statement legitimately takes minutes, and
// crying stalled at a real run is worse than reporting a dead one late.
export const STALE_PROGRESS_THRESHOLD_MS = 10 * 60 * 1000;

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

/**
 * Not finished yet — covers a run waiting for someone to start it as well as
 * one being worked on. Use this for lifecycle questions ("can this be
 * cancelled?"), NOT for "is something happening right now".
 */
export function isActiveRunStatus(status: string | null | undefined): boolean {
  const normalized = normalizeRunStatus(status);
  return typeof normalized === "string" && ACTIVE_STATUSES.has(normalized);
}

/**
 * Work is genuinely underway.
 *
 * "queued" is deliberately excluded. server.ts:504 inserts the run as "queued"
 * at UPLOAD, and the process route only moves it to "processing" when work
 * actually starts — uploading is not the same act as asking for processing
 * (see tests/accounting/export.test.ts). Treating "queued" as in-flight made an
 * untouched upload indistinguishable from a stuck job: production showed a
 * "Processing…" banner and a pipeline frozen on "Detecting PDF type" for a run
 * nobody had asked to process, while the UI polled it 102 times waiting for a
 * transition that could never come.
 */
export function isRunInFlight(status: string | null | undefined): boolean {
  const normalized = normalizeRunStatus(status);
  return normalized === "processing" || normalized === "pending";
}

/**
 * A run the worker accepted but which has shown no movement since.
 *
 * Background work on the worker dies with the process — a restart or deploy
 * mid-run leaves the run in "processing" with nobody working on it. There is
 * deliberately NO automatic retry: the worker may still be running and about to
 * commit, and a retry would duplicate a statement's transactions. The run is
 * reported as stalled so a person can decide, and Force Reprocess supersedes the
 * old job safely via the active_job_id fence.
 *
 * `acceptedAt` is job_accepted_at; `updatedAt` is the run's own updated_at, so
 * genuine progress writes keep a slow statement out of this state.
 */
export function isRunStalled(
  status: string | null | undefined,
  acceptedAt: string | null | undefined,
  updatedAt: string | null | undefined,
  now: number = Date.now(),
  thresholdMs: number = STALE_PROGRESS_THRESHOLD_MS,
): boolean {
  if (!isRunInFlight(status)) return false;
  if (!acceptedAt) return false; // never accepted — dispatch never completed
  const lastMovement = Date.parse(updatedAt || acceptedAt);
  if (Number.isNaN(lastMovement)) return false;
  return now - lastMovement > thresholdMs;
}

/** Uploaded and waiting for an explicit Process action. */
export function isRunAwaitingProcessing(status: string | null | undefined): boolean {
  return normalizeRunStatus(status) === "queued";
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

// Derive the status the UI should show. The explicit server lifecycle status is
// authoritative. In particular, reprocessing intentionally keeps the previous
// ledger readable, so transactionCount > 0 is not evidence that the new job is
// complete while the run says processing.
export function deriveEffectiveRunStatus(run: RunStatusSignals, transactionCount?: number): AccountingRunStatus | null {
  const status = normalizeRunStatus(run.status ?? null);
  if (status === "error") return "failed";
  if (status === "pending") return "processing";
  if (isTerminalRunStatus(status)) return status;
  if (status === "processing") return "processing";

  const vs = (run.validationStatus ?? "").toLowerCase();
  const txCount = transactionCount ?? run.transactionCount ?? 0;

  if (vs === "failed") return "failed";
  if (run.requiresReview === true || vs === "review" || vs === "review_required") return "review";
  if (txCount > 0 || vs === "valid" || vs === "completed") return "completed";

  return status; // still genuinely processing / queued
}

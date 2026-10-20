// What the combine route may tell the browser about a failed worker call.
//
// The route used to return the worker's body as the error (falling back to the
// raw text or a JSON dump of it), together with the worker's URL, endpoint and
// HTTP status. A FastAPI validation error echoes the request; an unhandled one
// can carry a traceback or a database message. Only the worker's own
// HTTPException messages — written for people in workers/accounting_worker —
// are passed on, and only for the statuses those use. Everything else becomes
// one generic sentence and a 502.

export type CombineWorkerFailure = {
  error: string;
  status: string;
  allowOverride: boolean;
  httpStatus: number;
  /** Whether the worker's own message reached the client (for the server log). */
  passedThrough: boolean;
};

const GENERIC = "Combined workbook generation failed. Please try again.";
// 400: fewer than two statements; 404: a statement is missing; 409/422: a
// combine rule (status, account mismatch, continuity review).
const DELIBERATE_STATUSES = new Set([400, 404, 409, 422]);
const MAX_MESSAGE_LENGTH = 500;

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_MESSAGE_LENGTH;
}

export function combineWorkerFailure(workerStatus: number, bodyText: string): CombineWorkerFailure {
  const generic: CombineWorkerFailure = { error: GENERIC, status: "combine_failed", allowOverride: false, httpStatus: 502, passedThrough: false };
  if (!DELIBERATE_STATUSES.has(workerStatus)) return generic;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return generic;
  }
  const detail = parsed && typeof parsed === "object" ? (parsed as { detail?: unknown }).detail : undefined;

  // HTTPException(detail="...") — a plain sentence.
  if (usable(detail)) {
    return { error: detail, status: "combine_failed", allowOverride: false, httpStatus: workerStatus, passedThrough: true };
  }

  // HTTPException(detail={"status": "review_required", "message": ..., "allow_override": true}):
  // the continuity check, which the UI answers with the override dialog.
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>;
    if (record.status === "review_required" && usable(record.message)) {
      return {
        error: record.message,
        status: "review_required",
        allowOverride: record.allow_override === true,
        httpStatus: workerStatus,
        passedThrough: true,
      };
    }
  }

  // A list `detail` is FastAPI request validation, which echoes the request.
  return generic;
}

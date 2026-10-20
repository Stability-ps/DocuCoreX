// Pure classification of an accounting-worker failure, kept out of the route
// module so it can be unit tested without pulling in next/server.

/**
 * True when the worker failed because there was nothing parseable in the PDF —
 * as opposed to a configuration, auth or transport error, which OCR cannot fix.
 *
 * This gates the Enhanced-OCR retry: a bank statement the Python worker cannot
 * read at all is almost always scanned, and re-running the pipeline with the
 * secondary OCR engine is worth one attempt. Burning that attempt on a 404 from
 * a misconfigured ACCOUNTING_WORKER_URL would just add latency to a failure.
 */
export function isNoTransactionsFailure(status: number, message: string): boolean {
  if (status === 422) return true;
  // 4xx/5xx transport and configuration failures are not content problems.
  if (status === 401 || status === 403 || status === 404 || status === 502 || status === 503 || status === 504) return false;
  return /no fnb transactions|no transactions could be parsed|no readable text/i.test(message);
}

export type WorkerResponseBody = {
  detail?: unknown;
  error?: string;
  status?: string;
  worker?: unknown;
  [key: string]: unknown;
};

/**
 * A user-safe sentence for a worker HTTP failure that carried no usable JSON.
 *
 * A non-JSON body is not the worker's own verdict — it is a proxy, platform or
 * crash page, and it used to be copied (up to 800 characters, or whole when it
 * reached the `detail` branch) into the run's error, which the workspace shows.
 * Only its status is used; the route logs the status and length.
 */
export function workerStatusMessage(status: number): string {
  // The reason phrase, deliberately: normalizeWorkerFailure turns it into the
  // endpoint-misconfigured message, as it does the worker's own 404 body.
  if (status === 404) return "Not Found";
  if (status === 408 || status === 504) return `The accounting worker timed out (HTTP ${status}). Please try again.`;
  if (status === 413) return "The statement is too large for the accounting worker (HTTP 413).";
  if (status === 429) return "The accounting worker is busy (HTTP 429). Please try again shortly.";
  if (status === 502 || status === 503) return `The accounting worker is temporarily unavailable (HTTP ${status}). Please try again shortly.`;
  if (status >= 500) return `The accounting worker failed (HTTP ${status}). Please try again.`;
  return `The accounting worker rejected the request (HTTP ${status}).`;
}

/**
 * The failure message from a worker response. `result` is the parsed JSON body,
 * or null when the body was empty or not JSON — then only the status is used.
 */
export function getWorkerError(result: WorkerResponseBody | null, status: number): string {
  if (!result) return workerStatusMessage(status);

  if (typeof result.error === "string" && result.error) {
    return result.error;
  }

  if (typeof result.detail === "string" && result.detail) {
    return result.detail;
  }

  if (Array.isArray(result.detail)) {
    return result.detail
      .map((item) => {
        if (item && typeof item === "object") {
          const record = item as { loc?: unknown; msg?: unknown; type?: unknown };
          const loc = Array.isArray(record.loc) ? record.loc.join(".") : "field";
          return `${loc}: ${String(record.msg ?? record.type ?? "Invalid value")}`;
        }
        return String(item);
      })
      .join("; ");
  }

  if (result.detail && typeof result.detail === "object") {
    return JSON.stringify(result.detail);
  }

  return workerStatusMessage(status);
}

/**
 * The run error for a worker failure. Configuration failures name the setting to
 * fix, but never the worker's URL or its service metadata — the route logs
 * those; they are not stored on a run the whole workspace can read.
 */
export function normalizeWorkerFailure(input: { status: number; message: string }): string {
  const detail = input.message.trim();
  const isNotFound = input.status === 404 && (detail === "Not Found" || detail.toLowerCase() === "not found");

  if (isNotFound) {
    return "Accounting worker endpoint not found. ACCOUNTING_WORKER_URL is misconfigured.";
  }

  // The worker's auth fails closed, so these two statuses mean a configuration
  // mismatch, not a bad statement. Say so — otherwise an operator reads
  // "Invalid credentials" on an upload screen and goes looking at the PDF.
  if (input.status === 503 && /not configured for authenticated access/i.test(detail)) {
    return "Accounting worker has no ACCOUNTING_WORKER_TOKEN configured, so it is refusing all requests. Set it on the worker service.";
  }
  if (input.status === 401) {
    // The worker's own detail is APPENDED, not discarded. Its three 401 verdicts
    // mean different things — "Missing Authorization header." says this runtime
    // sent nothing, "Invalid credentials." says it sent the wrong value — and
    // collapsing them into one message made an absent token indistinguishable
    // from a mismatched one during the 2026-08-06 investigation.
    const verdict = detail ? ` Worker said: ${detail}` : "";
    return `Accounting worker rejected our credentials. ACCOUNTING_WORKER_TOKEN must be set to the same value here and on the worker service.${verdict}`;
  }

  return detail || workerStatusMessage(input.status);
}

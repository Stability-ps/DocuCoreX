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

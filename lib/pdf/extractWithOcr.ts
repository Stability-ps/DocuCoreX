import type { ExtractionResult } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// OCR fallback for scanned / weak-text PDFs. Calls the conversion worker's
// /api/ocr-text endpoint (ocrmypdf / tesseract). Runs ONLY when the caller
// decides OCR is needed; time-bounded and degrades gracefully.
const OCR_FETCH_TIMEOUT_MS = readTimeoutMs(process.env.CONVERSION_OCR_TIMEOUT_MS ?? process.env.ACCOUNTING_OCR_TIMEOUT_MS, 300_000);
// A 502 means the conversion worker crashed / was momentarily unavailable (an
// OOM restart, a cold instance). Retry ONCE after a short delay; a transient 502
// usually clears once the instance is back (Req 9).
const OCR_RETRY_ON_502_DELAY_MS = 5_000;
const OCR_MAX_ATTEMPTS = 2; // initial + one retry on 502

// Failure result carrying the OCR diagnostics so the reason is never hidden. When
// the worker is unavailable (HTTP 502) even after a retry, flag the statement for
// review (_ocrRequiresReview) so the pipeline surfaces it instead of silently
// producing an empty extraction (Req 9).
function ocrFailure(endpoint: string, status: number, detail: string, requiresReview: boolean): ExtractionResult {
  return {
    parser: "ocr",
    pageCount: 0,
    pages: [],
    combinedText: "",
    transactions: [],
    metadata: {
      _ocrDebug: { ocr_endpoint: endpoint, ocr_status: status, ocr_stderr_sample: detail.slice(0, 2000) },
      _ocrReason: `OCR service returned HTTP ${status}`,
      _ocrRequiresReview: requiresReview,
    },
    warnings: [
      requiresReview
        ? `OCR service unavailable (HTTP ${status}) after retry — flagged for review.`
        : `OCR service returned HTTP ${status}: ${detail.slice(0, 200)}`,
    ],
  };
}

export async function extractWithOcr(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const baseUrl = process.env.CONVERSION_WORKER_URL;
  const secret = process.env.CONVERSION_WORKER_SECRET;
  if (!baseUrl) {
    pdfLog("ocr.skipped", { reason: "CONVERSION_WORKER_URL not configured" });
    return null;
  }

  // Conversion worker routes live under /api (it is the Next.js app in worker mode).
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/ocr-text`;

  // Build the multipart body from a FRESH copy — never a previously-consumed /
  // possibly-detached Uint8Array (PDF.js detaches the buffers it processes).
  const ocrBytes = new Uint8Array(buffer);
  pdfLog("ocr_started", { endpoint, fileName, fileSize: buffer.byteLength, ocr_bytes: ocrBytes.byteLength });

  let lastStatus = 0;
  let lastErrorBody = "";

  for (let attempt = 1; attempt <= OCR_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OCR_FETCH_TIMEOUT_MS);
    const started = Date.now();
    try {
      const form = new FormData();
      form.append("file", new Blob([ocrBytes], { type: "application/pdf" }), fileName);
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        headers: secret ? { "x-docucorex-worker-secret": secret } : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        lastStatus = response.status;
        lastErrorBody = errorBody;
        pdfLog("ocr.error", { endpoint, status: response.status, attempt, errorBody: errorBody.slice(0, 500) });

        // Retry ONCE on a 502 (worker crashed / unavailable) after a short delay.
        if (response.status === 502 && attempt < OCR_MAX_ATTEMPTS) {
          pdfLog("ocr.retry", { reason: "HTTP 502", delayMs: OCR_RETRY_ON_502_DELAY_MS, nextAttempt: attempt + 1 });
          await new Promise((resolve) => setTimeout(resolve, OCR_RETRY_ON_502_DELAY_MS));
          continue;
        }
        // Any other error, or a 502 that survived the retry → return a failure
        // result (a persistent 502 is flagged for review).
        return ocrFailure(endpoint, response.status, errorBody, response.status === 502);
      }

      const data = (await response.json().catch(() => ({}))) as {
        text?: string;
        pages?: number;
        confidence?: number;
        warnings?: string[];
        reason?: string | null;
        ocrDebug?: Record<string, unknown>;
      };
      const combinedText = data.text ?? "";
      pdfLog("ocr_finished", {
        endpoint,
        status: response.status,
        attempt,
        textLength: combinedText.trim().length,
        pages: data.pages ?? 0,
        transactions: parseTransactionsFromText(combinedText).length,
        confidence: data.confidence ?? null,
        reason: data.reason ?? null,
        ocrDebug: data.ocrDebug ?? null,
        sample: combinedText.trim().slice(0, 500),
        ms: Date.now() - started,
      });

      return {
        parser: "ocr",
        pageCount: data.pages ?? (combinedText ? 1 : 0),
        pages: combinedText ? [{ pageNumber: 1, text: combinedText, words: [], tables: [], lines: [] }] : [],
        combinedText,
        transactions: parseTransactionsFromText(combinedText),
        // Carry the OCR engine diagnostics + endpoint so the reason is never hidden.
        metadata: { ...parseStatementMetadata(combinedText), _ocrDebug: { ocr_endpoint: endpoint, ...(data.ocrDebug ?? {}) }, _ocrReason: data.reason ?? null },
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const message = aborted ? `timed out after ${OCR_FETCH_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
      pdfLog("ocr.error", { endpoint, attempt, error: message });
      return {
        parser: "ocr",
        pageCount: 0,
        pages: [],
        combinedText: "",
        transactions: [],
        metadata: { _ocrDebug: { ocr_endpoint: endpoint, ocr_stderr_sample: message }, _ocrReason: aborted ? "OCR timed out" : `OCR unreachable: ${message}`, _ocrRequiresReview: true },
        warnings: [aborted ? "OCR timed out — flagged for review." : `OCR unreachable: ${message}`],
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Exhausted the retry budget on repeated 502s.
  pdfLog("ocr.error", { endpoint, status: lastStatus, exhausted: true });
  return ocrFailure(endpoint, lastStatus || 502, lastErrorBody, true);
}

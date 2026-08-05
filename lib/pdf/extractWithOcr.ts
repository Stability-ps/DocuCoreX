import type { ExtractionResult } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// OCR fallback for scanned / weak-text PDFs, backed by ocrmypdf / tesseract.
//
// TWO TRANSPORTS, ONE IMPLEMENTATION:
//   • Vercel (default)  → HTTP POST to {CONVERSION_WORKER_URL}/api/ocr-text
//   • Conversion worker → the SAME engine called in-process (lib/pdf/ocrEngine)
//
// When the pipeline already runs on the worker (CONVERSION_WORKER_MODE=true), an
// HTTP call would be a request to ourselves. That is not merely wasteful: the
// engine drives ocrmypdf through spawnSync, which BLOCKS the Node event loop, so
// a self-call parks one request while a second freezes the instance for the whole
// OCR duration — during which the Render health check cannot respond and the
// instance may be restarted mid-OCR. Calling in-process removes the hop entirely.
//
// Both transports normalise through toExtractionResult() / ocrFailure() below, so
// the ExtractionResult a caller sees is equivalent either way.
//
// 120s default keeps the OCR fetch bounded well under the Vercel function
// maxDuration (300s), so a hung Render OCR times out cleanly instead of the
// function being killed mid-request. Env-overridable for edge cases.
const OCR_FETCH_TIMEOUT_MS = readTimeoutMs(process.env.CONVERSION_OCR_TIMEOUT_MS ?? process.env.ACCOUNTING_OCR_TIMEOUT_MS, 120_000);
// A 502 means the conversion worker crashed / was momentarily unavailable (an
// OOM restart, a cold instance). Retry ONCE after a short delay; a transient 502
// usually clears once the instance is back (Req 9).
const OCR_RETRY_ON_502_DELAY_MS = 5_000;
const OCR_MAX_ATTEMPTS = 2; // initial + one retry on 502

export function isConversionWorkerMode(): boolean {
  return process.env.CONVERSION_WORKER_MODE === "true";
}

// The payload shape both transports produce (the /api/ocr-text response body).
type OcrPayload = {
  text?: string;
  pages?: number;
  confidence?: number;
  confidenceSource?: string;
  lowConfidenceWordRatio?: number | null;
  warnings?: string[];
  reason?: string | null;
  ocrDebug?: Record<string, unknown>;
};

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
    confidence: null,
    confidenceSource: null,
  };
}

// Shared success mapping — used by BOTH transports so their results are equivalent.
function toExtractionResult(data: OcrPayload, endpoint: string): ExtractionResult {
  const combinedText = data.text ?? "";
  return {
    parser: "ocr",
    pageCount: data.pages ?? (combinedText ? 1 : 0),
    pages: combinedText ? [{ pageNumber: 1, text: combinedText, words: [], tables: [], lines: [] }] : [],
    combinedText,
    transactions: parseTransactionsFromText(combinedText),
    // Carry the OCR engine diagnostics + endpoint so the reason is never hidden.
    metadata: { ...parseStatementMetadata(combinedText), _ocrDebug: { ocr_endpoint: endpoint, ...(data.ocrDebug ?? {}) }, _ocrReason: data.reason ?? null },
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    // Engine-reported recognition confidence. The escalation decision and the
    // engine comparison both depend on it.
    confidence: typeof data.confidence === "number" ? data.confidence : null,
    confidenceSource: data.confidenceSource ?? (typeof data.confidence === "number" ? "heuristic" : null),
  };
}

// Content-free completion log, shared by both transports.
function logFinished(endpoint: string, transport: "http" | "in-process", status: number, attempt: number, data: OcrPayload, ms: number) {
  const combinedText = data.text ?? "";
  pdfLog("ocr_finished", {
    endpoint,
    transport,
    status,
    attempt,
    // Only safe, content-free diagnostics — never the OCR'd document text.
    textLength: combinedText.trim().length,
    pages: data.pages ?? 0,
    transactions: parseTransactionsFromText(combinedText).length,
    confidence: data.confidence ?? null,
    confidenceSource: data.confidenceSource ?? null,
    reason: data.reason ?? null,
    ocrDebug: data.ocrDebug ?? null,
    ms,
  });
}

// In-process transport. Only reachable on the conversion worker, which ships the
// native binaries. The engine enforces its own per-attempt and total time budgets
// via spawnSync `timeout`, so no AbortController is needed here.
async function extractInProcess(buffer: Uint8Array, fileName: string): Promise<ExtractionResult> {
  const endpoint = "in-process";
  const started = Date.now();
  pdfLog("ocr_started", { endpoint, transport: "in-process", fileName, fileSize: buffer.byteLength });
  try {
    // Dynamic import keeps node:child_process and the native-binary code out of
    // any bundle that never runs OCR (e.g. the Vercel deployment).
    const { runOcrText } = await import("@/lib/pdf/ocrEngine");
    const result = runOcrText(new Uint8Array(buffer), fileName, endpoint);
    if (result.status === 200) {
      logFinished(endpoint, "in-process", 200, 1, result.body, Date.now() - started);
      return toExtractionResult(result.body, endpoint);
    }
    // Non-200 → the same failure shape an HTTP caller would have produced for
    // this status, so both transports degrade identically.
    const detail = "error" in result.body ? result.body.error : (result.body.reason ?? JSON.stringify(result.body.ocrDebug ?? {}));
    pdfLog("ocr.error", { endpoint, transport: "in-process", status: result.status });
    return ocrFailure(endpoint, result.status, detail, result.status === 504);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pdfLog("ocr.error", { endpoint, transport: "in-process", error: message });
    return {
      parser: "ocr",
      pageCount: 0,
      pages: [],
      combinedText: "",
      transactions: [],
      metadata: { _ocrDebug: { ocr_endpoint: endpoint, ocr_stderr_sample: message }, _ocrReason: `OCR failed in-process: ${message}`, _ocrRequiresReview: true },
      warnings: [`OCR failed in-process: ${message}`],
      confidence: null,
      confidenceSource: null,
    };
  }
}

export async function extractWithOcr(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  // Worker mode: the OCR binaries are HERE. Call the engine directly and never
  // issue an HTTP request to ourselves. CONVERSION_WORKER_URL is irrelevant on
  // this path, so OCR works on the worker even when that variable is unset.
  if (isConversionWorkerMode()) {
    return extractInProcess(buffer, fileName);
  }

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
  pdfLog("ocr_started", { endpoint, transport: "http", fileName, fileSize: buffer.byteLength, ocr_bytes: ocrBytes.byteLength });

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
        pdfLog("ocr.error", { endpoint, transport: "http", status: response.status, attempt, errorBody: errorBody.slice(0, 500) });

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

      const data = (await response.json().catch(() => ({}))) as OcrPayload;
      logFinished(endpoint, "http", response.status, attempt, data, Date.now() - started);
      return toExtractionResult(data, endpoint);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const message = aborted ? `timed out after ${OCR_FETCH_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
      pdfLog("ocr.error", { endpoint, transport: "http", attempt, error: message });
      return {
        parser: "ocr",
        pageCount: 0,
        pages: [],
        combinedText: "",
        transactions: [],
        metadata: { _ocrDebug: { ocr_endpoint: endpoint, ocr_stderr_sample: message }, _ocrReason: aborted ? "OCR timed out" : `OCR unreachable: ${message}`, _ocrRequiresReview: true },
        warnings: [aborted ? "OCR timed out — flagged for review." : `OCR unreachable: ${message}`],
        confidence: null,
        confidenceSource: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Exhausted the retry budget on repeated 502s.
  pdfLog("ocr.error", { endpoint, transport: "http", status: lastStatus, exhausted: true });
  return ocrFailure(endpoint, lastStatus || 502, lastErrorBody, true);
}

// Test seam: the pure normalisation both transports share.
export const __testables = { toExtractionResult, ocrFailure };

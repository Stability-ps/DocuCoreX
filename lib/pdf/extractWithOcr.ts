import type { ExtractionResult } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

// OCR fallback for scanned / weak-text PDFs. Calls the conversion worker's
// /api/ocr-text endpoint (ocrmypdf / tesseract). Runs ONLY when the caller
// decides OCR is needed; time-bounded and degrades gracefully.
const OCR_FETCH_TIMEOUT_MS = 180_000;

export async function extractWithOcr(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const baseUrl = process.env.CONVERSION_WORKER_URL;
  const secret = process.env.CONVERSION_WORKER_SECRET;
  if (!baseUrl) {
    pdfLog("ocr.skipped", { reason: "CONVERSION_WORKER_URL not configured" });
    return null;
  }

  // Conversion worker routes live under /api (it is the Next.js app in worker mode).
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/ocr-text`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_FETCH_TIMEOUT_MS);

  pdfLog("ocr.request_started", { endpoint, fileName, fileSize: buffer.byteLength });
  try {
    const form = new FormData();
    form.append("file", new Blob([buffer.slice() as unknown as BlobPart], { type: "application/pdf" }), fileName);
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      headers: secret ? { "x-docucorex-worker-secret": secret } : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      pdfLog("ocr.error", { endpoint, status: response.status, errorBody: errorBody.slice(0, 500) });
      return { parser: "ocr", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [`OCR service returned HTTP ${response.status}: ${errorBody.slice(0, 200)}`] };
    }

    const data = (await response.json().catch(() => ({}))) as { text?: string; pages?: number; confidence?: number; warnings?: string[] };
    const combinedText = data.text ?? "";
    pdfLog("ocr.response", {
      endpoint,
      status: response.status,
      textLength: combinedText.trim().length,
      pages: data.pages ?? 0,
      confidence: data.confidence ?? null,
      sample: combinedText.trim().slice(0, 500),
    });

    const result: ExtractionResult = {
      parser: "ocr",
      pageCount: data.pages ?? (combinedText ? 1 : 0),
      pages: combinedText ? [{ pageNumber: 1, text: combinedText, words: [], tables: [], lines: [] }] : [],
      combinedText,
      transactions: parseTransactionsFromText(combinedText),
      metadata: parseStatementMetadata(combinedText),
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
    };
    return result;
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    pdfLog("ocr.error", { endpoint, error: aborted ? `timed out after ${OCR_FETCH_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error) });
    return { parser: "ocr", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [aborted ? "OCR timed out" : `OCR unreachable: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    clearTimeout(timeout);
  }
}

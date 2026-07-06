import type { ExtractionResult } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

// OCR fallback for scanned / weak-text PDFs. Uses the existing conversion worker
// (CONVERSION_WORKER_URL, which runs ocrmypdf / tesseract) when available. Runs
// ONLY when the caller decides OCR is needed; degrades gracefully otherwise.
export async function extractWithOcr(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const baseUrl = process.env.CONVERSION_WORKER_URL;
  const secret = process.env.CONVERSION_WORKER_SECRET;
  if (!baseUrl) {
    pdfLog("ocr.skipped", { reason: "CONVERSION_WORKER_URL not configured" });
    return null;
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([buffer.slice() as unknown as BlobPart], { type: "application/pdf" }), fileName);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/ocr-text`, {
      method: "POST",
      body: form,
      headers: secret ? { "x-docucorex-worker-secret": secret } : undefined,
    });
    if (!response.ok) {
      pdfLog("ocr.error", { status: response.status });
      return { parser: "ocr", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [`OCR service returned HTTP ${response.status}`] };
    }
    const data = (await response.json()) as { text?: string; pageCount?: number };
    const combinedText = data.text ?? "";
    const result: ExtractionResult = {
      parser: "ocr",
      pageCount: data.pageCount ?? 0,
      pages: combinedText ? [{ pageNumber: 1, text: combinedText, words: [], tables: [], lines: [] }] : [],
      combinedText,
      transactions: parseTransactionsFromText(combinedText),
      metadata: parseStatementMetadata(combinedText),
      warnings: [],
    };
    pdfLog("ocr.extract", { chars: combinedText.length, transactions: result.transactions.length });
    return result;
  } catch (error) {
    pdfLog("ocr.error", { error: error instanceof Error ? error.message : String(error) });
    return { parser: "ocr", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [`OCR unreachable: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

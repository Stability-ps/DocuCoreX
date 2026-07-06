import type { ExtractionPage, ExtractionResult, ExtractionTable } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

// Calls the separate pdfplumber FastAPI service (PDF_PLUMBER_URL) which returns
// text, words, tables, lines and coordinates per page. Degrades gracefully when
// the service is not configured or unreachable. Time-bounded at 15s (Req 2).
const PDFPLUMBER_TIMEOUT_MS = 15_000;

export async function extractWithPdfplumber(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const baseUrl = process.env.PDF_PLUMBER_URL;
  if (!baseUrl) {
    pdfLog("pdfplumber.skipped", { reason: "PDF_PLUMBER_URL not configured" });
    return null;
  }

  const started = Date.now();
  // Fresh copy for the multipart body — never a previously-consumed / detached view.
  const plumberBytes = new Uint8Array(buffer);
  pdfLog("pdfplumber_started", { fileSize: buffer.byteLength, pdfplumber_bytes: plumberBytes.byteLength });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PDFPLUMBER_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", new Blob([plumberBytes], { type: "application/pdf" }), fileName);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/extract`, { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) {
      pdfLog("pdfplumber_finished", { ok: false, status: response.status, ms: Date.now() - started });
      return {
        parser: "pdfplumber",
        pageCount: 0,
        pages: [],
        combinedText: "",
        transactions: [],
        metadata: {},
        warnings: [`pdfplumber service returned HTTP ${response.status}`],
      };
    }
    const data = (await response.json()) as {
      pageCount?: number;
      pages?: Array<{ pageNumber?: number; text?: string; words?: unknown[]; tables?: string[][][]; lines?: unknown[] }>;
      combinedText?: string;
    };

    const pages: ExtractionPage[] = (data.pages ?? []).map((p, index) => ({
      pageNumber: p.pageNumber ?? index + 1,
      text: p.text ?? "",
      words: Array.isArray(p.words) ? (p.words as ExtractionPage["words"]) : [],
      tables: Array.isArray(p.tables) ? p.tables.map((rows): ExtractionTable => ({ rows: rows.map((row) => row.map((c) => String(c ?? ""))) })) : [],
      lines: Array.isArray(p.lines) ? (p.lines as ExtractionPage["lines"]) : [],
    }));
    const combinedText = data.combinedText ?? pages.map((p) => p.text).join("\n");
    const result: ExtractionResult = {
      parser: "pdfplumber",
      pageCount: data.pageCount ?? pages.length,
      pages,
      combinedText,
      transactions: parseTransactionsFromText(combinedText),
      metadata: parseStatementMetadata(combinedText),
      warnings: [],
    };
    pdfLog("pdfplumber_finished", { pages: result.pageCount, tables: pages.reduce((s, p) => s + p.tables.length, 0), chars: combinedText.length, transactions: result.transactions.length, ms: Date.now() - started });
    return result;
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    const message = aborted ? `timed out after ${PDFPLUMBER_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
    pdfLog("pdfplumber_finished", { ok: false, error: message, ms: Date.now() - started });
    return {
      parser: "pdfplumber",
      pageCount: 0,
      pages: [],
      combinedText: "",
      transactions: [],
      metadata: {},
      warnings: [aborted ? "pdfplumber timed out" : `pdfplumber unreachable: ${message}`],
    };
  } finally {
    clearTimeout(timeout);
  }
}

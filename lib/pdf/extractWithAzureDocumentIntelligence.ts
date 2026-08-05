// Azure Document Intelligence (prebuilt-layout) as a first-class extraction
// provider, alongside PDF.js, pdfplumber, Tesseract and Mistral.
//
// Deliberately mirrors extractWithMistralOcr.ts / extractWithOcr.ts: same
// signature, same normalized ExtractionResult, same "never throw into the
// pipeline" contract, same content-free logging. Nothing Azure-specific leaks
// past this module — the pipeline treats it as one more interchangeable source.
//
// API (verified against learn.microsoft.com, rest-aiservices-v4.0 / 2024-11-30):
//   POST {endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze
//        ?_overload=analyzeDocument&api-version=2024-11-30
//   Ocp-Apim-Subscription-Key: <key>
//   { "base64Source": "<base64 pdf>" }
//   → 202 + Operation-Location header (+ Retry-After)
//   → GET Operation-Location until status is succeeded | failed
//   → { status, analyzeResult: { content, pages[], tables[], paragraphs[] } }
//
// NOTE on output format: `outputContentFormat` is left at its default (plain
// text) ON PURPOSE. The markdown option returns pipe tables and headings, which
// the downstream FNB parsers — written against fixed-column text — cannot read.
// Requesting markdown here would reproduce the exact defect fixed in
// mergeExtractionResults (verbose text that parses into far fewer rows).
//
// SECURITY: the key is read from the environment at call time and is never
// logged, returned or persisted.
import type { ExtractionResult, ExtractionPage } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

const AZURE_API_VERSION = "2024-11-30";
const AZURE_MODEL = "prebuilt-layout";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Total wall-clock budget for submit + poll, and the poll interval. Read at CALL
// time, not module load, so the value is never baked in at import (and so tests
// can drive them). Matches the other engines: no provider outlives its caller.
function azureBudgets() {
  return {
    timeoutMs: readTimeoutMs(process.env.AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS, 120_000),
    pollMs: readTimeoutMs(process.env.AZURE_DOCUMENT_INTELLIGENCE_POLL_MS, 2_000),
  };
}

export function azureEndpoint(): string | null {
  const raw = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  return raw ? raw.replace(/\/$/, "") : null;
}

export function isAzureConfigured(): boolean {
  return Boolean(azureEndpoint() && process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim());
}

// Pure: the analyze URL for a model. Exported for tests.
export function buildAnalyzeUrl(endpoint: string, model = AZURE_MODEL): string {
  return `${endpoint.replace(/\/$/, "")}/documentintelligence/documentModels/${model}:analyze?_overload=analyzeDocument&api-version=${AZURE_API_VERSION}`;
}

type AzurePage = {
  pageNumber?: number;
  words?: Array<{ content?: string; confidence?: number }>;
  lines?: Array<{ content?: string }>;
  spans?: Array<{ offset?: number; length?: number }>;
};

type AzureAnalyzeResult = {
  content?: string;
  pages?: AzurePage[];
  tables?: Array<{ rowCount?: number; columnCount?: number; cells?: Array<{ rowIndex?: number; columnIndex?: number; content?: string }> }>;
  paragraphs?: Array<{ content?: string }>;
};

type AzureOperation = {
  status?: "notStarted" | "running" | "succeeded" | "failed" | string;
  analyzeResult?: AzureAnalyzeResult;
  error?: { code?: string; message?: string };
};

/** Diagnostics surfaced in parser debug alongside the other providers. */
export type AzureDebug = {
  provider: "azure_di";
  model: string;
  pages: number;
  tables: number;
  paragraphs: number;
  words: number;
  confidence: number | null;
  duration_ms: number;
  status: number | string;
};

// Pure: mean per-word confidence, scaled to 0..100. Azure reports 0..1.
export function meanWordConfidence(pages: AzurePage[]): number | null {
  const values: number[] = [];
  for (const page of pages) {
    for (const word of page.words ?? []) {
      if (typeof word.confidence === "number" && Number.isFinite(word.confidence)) values.push(word.confidence);
    }
  }
  if (!values.length) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const scaled = mean <= 1 ? mean * 100 : mean;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

// Pure: Azure table cells → the pipeline's row-major table shape, so
// scoreExtraction can count transaction rows exactly as it does for pdfplumber.
export function toExtractionTables(tables: AzureAnalyzeResult["tables"]): string[][][] {
  return (tables ?? []).map((table) => {
    const rows: string[][] = Array.from({ length: table.rowCount ?? 0 }, () => Array.from({ length: table.columnCount ?? 0 }, () => ""));
    for (const cell of table.cells ?? []) {
      const r = cell.rowIndex ?? 0;
      const c = cell.columnIndex ?? 0;
      if (rows[r] && c < rows[r].length) rows[r][c] = String(cell.content ?? "");
    }
    return rows;
  });
}

// Pure: split Azure's flat `content` into per-page text using each page's spans.
// Falls back to one page carrying everything when spans are absent.
export function splitContentByPages(content: string, pages: AzurePage[]): ExtractionPage[] {
  if (!pages.length) return content ? [{ pageNumber: 1, text: content, words: [], tables: [], lines: [] }] : [];
  return pages.map((page, index) => {
    const span = page.spans?.[0];
    const text =
      typeof span?.offset === "number" && typeof span?.length === "number"
        ? content.slice(span.offset, span.offset + span.length)
        : (page.lines ?? []).map((l) => l.content ?? "").join("\n");
    return { pageNumber: page.pageNumber ?? index + 1, text, words: [], tables: [], lines: [] };
  });
}

function azureFailure(status: number | string, detail: string, requiresReview: boolean): ExtractionResult {
  return {
    parser: "azure_di",
    pageCount: 0,
    pages: [],
    combinedText: "",
    transactions: [],
    metadata: {
      _azureDebug: { provider: "azure_di", model: AZURE_MODEL, status, detail: detail.slice(0, 2000) },
      _azureReason: `Azure Document Intelligence returned ${status}`,
      _azureRequiresReview: requiresReview,
    },
    warnings: [`Azure Document Intelligence returned ${status}: ${detail.slice(0, 200)}`],
    confidence: null,
    confidenceSource: null,
  };
}

export async function extractWithAzureDocumentIntelligence(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const endpoint = azureEndpoint();
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();
  if (!endpoint || !key) {
    pdfLog("azure.skipped", { reason: "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/KEY not configured" });
    return null;
  }

  const { timeoutMs: AZURE_TIMEOUT_MS, pollMs: AZURE_POLL_INTERVAL_MS } = azureBudgets();
  const started = Date.now();
  const deadline = started + AZURE_TIMEOUT_MS;
  const bytes = new Uint8Array(buffer);
  pdfLog("azure_started", { model: AZURE_MODEL, fileName, fileSize: bytes.byteLength });

  try {
    // ---- Submit ---------------------------------------------------------------
    const submit = await fetch(buildAnalyzeUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": key },
      // v4.0 GA takes the document inline as base64Source (or a urlSource); it
      // does not accept a raw binary body. This uploads the PDF directly, with
      // no blob staging.
      body: JSON.stringify({ base64Source: Buffer.from(bytes).toString("base64") }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });

    if (submit.status !== 202) {
      const detail = await submit.text().catch(() => "");
      pdfLog("azure.error", { phase: "submit", status: submit.status, bodyLength: detail.length });
      // 4xx are configuration/quota problems the caller cannot fix by retrying.
      return azureFailure(submit.status, detail, submit.status >= 500);
    }

    const operationUrl = submit.headers.get("operation-location");
    if (!operationUrl) {
      pdfLog("azure.error", { phase: "submit", reason: "missing Operation-Location header" });
      return azureFailure(502, "Azure accepted the job but returned no Operation-Location header.", true);
    }

    // ---- Poll -----------------------------------------------------------------
    let operation: AzureOperation | null = null;
    let polls = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, AZURE_POLL_INTERVAL_MS));
      polls += 1;
      const poll = await fetch(operationUrl, {
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (!poll.ok) {
        const detail = await poll.text().catch(() => "");
        pdfLog("azure.error", { phase: "poll", status: poll.status, polls });
        return azureFailure(poll.status, detail, poll.status >= 500);
      }
      operation = (await poll.json().catch(() => null)) as AzureOperation | null;
      const status = operation?.status;
      if (status === "succeeded") break;
      if (status === "failed") {
        const message = operation?.error?.message ?? "analysis failed";
        pdfLog("azure.error", { phase: "poll", status: "failed", polls });
        return azureFailure("failed", message, false);
      }
      // notStarted | running | unknown → keep polling until the deadline.
    }

    if (operation?.status !== "succeeded") {
      pdfLog("azure.error", { phase: "poll", reason: "timed out", polls, ms: Date.now() - started });
      return azureFailure("timeout", `Azure analysis did not complete within ${AZURE_TIMEOUT_MS}ms`, true);
    }

    // ---- Normalize ------------------------------------------------------------
    const analyze = operation.analyzeResult ?? {};
    const azurePages = Array.isArray(analyze.pages) ? analyze.pages : [];
    const content = typeof analyze.content === "string" ? analyze.content : "";
    const pages = splitContentByPages(content, azurePages);
    const tables = toExtractionTables(analyze.tables);
    // Attach every table to its page where known, otherwise to the first page,
    // so scoreExtraction sees them at all.
    if (tables.length && pages.length) {
      pages[0] = { ...pages[0], tables: tables.map((rows) => ({ rows })) };
    }
    const combinedText = content || pages.map((p) => p.text).join("\n");
    const confidence = meanWordConfidence(azurePages);
    const wordCount = azurePages.reduce((sum, p) => sum + (p.words?.length ?? 0), 0);

    const debug: AzureDebug = {
      provider: "azure_di",
      model: AZURE_MODEL,
      pages: azurePages.length,
      tables: (analyze.tables ?? []).length,
      paragraphs: (analyze.paragraphs ?? []).length,
      words: wordCount,
      confidence,
      duration_ms: Date.now() - started,
      status: 200,
    };

    pdfLog("azure_finished", {
      // Content-free only — never the extracted document text.
      ...debug,
      textLength: combinedText.trim().length,
      transactions: parseTransactionsFromText(combinedText).length,
      polls,
    });

    return {
      parser: "azure_di",
      pageCount: azurePages.length || (combinedText ? 1 : 0),
      pages,
      combinedText,
      transactions: parseTransactionsFromText(combinedText),
      metadata: { ...parseStatementMetadata(combinedText), _azureDebug: debug, _azureReason: combinedText.trim().length === 0 ? "Azure returned no text" : null },
      warnings: combinedText.trim().length === 0 ? ["Azure Document Intelligence returned no text."] : [],
      confidence,
      confidenceSource: confidence == null ? null : "azure-word",
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut ? `timed out after ${AZURE_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
    pdfLog("azure.error", { phase: "exception", error: message });
    return azureFailure(timedOut ? "timeout" : "unreachable", message, true);
  }
}

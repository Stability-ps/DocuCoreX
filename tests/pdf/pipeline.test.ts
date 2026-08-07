import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { scoreExtraction } = await import("@/lib/pdf/scoreExtraction.ts");
const { analyzeExtraction } = await import("@/lib/pdf/analyzePdf.ts");
const mergeModule = await import("@/lib/pdf/mergeExtractionResults.ts");
const { mergeExtractionResults } = mergeModule;
const { selectExtractionStrategy } = await import("@/lib/pdf/extractionStrategy.ts");
const { validateBankStatement } = await import("@/lib/accounting/validateBankStatement.ts");
const { buildWorkerInput, extractionProcessingMetadata, parserMethodLabel } = await import("@/lib/pdf/workerHandoff.ts");
const { computeFileHash, getCachedExtraction, setCachedExtraction, clearExtractionCache } = await import("@/lib/pdf/extractionCache.ts");
const { deriveEffectiveRunStatus, isTerminalRunStatus } = await import("@/lib/accounting/run-status.ts");

function pipelineResult(over: Record<string, unknown> = {}) {
  return {
    analysis: { kind: "digital", isDigitalPdf: true, confidence: 90, needsOcr: false, pageCount: 4, totalTextLength: 4000, averageTextPerPage: 1000, pages: [], reasons: [], characters: 4000, averageCharsPerPage: 1000 },
    ocrUsed: false,
    parserMethod: "pdfplumber",
    routeReason: "Digital PDF → native parsers.",
    selection: { selectedParser: "pdfplumber", confidence: 85, reasons: [], warnings: [], requiresReview: false, extractionScores: {} },
    merged: { parser: "pdfplumber", pageCount: 4, pages: [], combinedText: "x".repeat(500), transactions: [{ debit: 100 }, { debit: 50 }], metadata: { openingBalance: 1000, closingBalance: 850 }, warnings: [] },
    validation: { valid: true, requiresReview: false, checks: [], expectedClosingBalance: 850, calculatedClosingBalance: 850, difference: 0, missingTransactionCount: 0 },
    warnings: [],
    requiresReview: false,
    ...over,
  };
}

test("buildWorkerInput hands the worker the best source and keeps PDF fallback", () => {
  const input = buildWorkerInput(pipelineResult() as never);
  assert.equal(input.parser, "pdfplumber");
  assert.equal(input.useProvidedText, true, "trusts substantial high-confidence text");
  assert.equal(input.transactionCandidateCount, 2);
  assert.ok(input.preExtractedText.length >= 200);

  // Thin / low-confidence text -> do not trust the provided text (PDF fallback).
  const thin = buildWorkerInput(pipelineResult({ merged: { parser: "pdfjs", pageCount: 1, pages: [], combinedText: "short", transactions: [], metadata: {}, warnings: [] }, selection: { selectedParser: "pdfjs", confidence: 20, reasons: [], warnings: [], requiresReview: true, extractionScores: {} } }) as never);
  assert.equal(thin.useProvidedText, false);
  assert.equal(thin.extractionFormatVersion, undefined);
  assert.equal(thin.preExtractedRows, undefined);
});

test("buildWorkerInput includes structured payload fields only when rows are usable", () => {
  const withStructured = buildWorkerInput(
    pipelineResult({
      merged: {
        parser: "azure_di",
        pageCount: 1,
        pages: [],
        combinedText: "01 Jan Payment 100.00 900.00 Cr",
        transactions: [{ debit: 100 }],
        metadata: {},
        warnings: [],
        structured: {
          tables: [],
          rows: [{
            pageNumber: 1,
            cells: { date: "01 Jan", description: "Payment", amount: "100.00", balance: "900.00 Cr" },
            raw: "01 Jan Payment 100.00 900.00 Cr",
            confidence: 0.98,
          }],
          layout: [],
          pageMeta: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 0 }],
          quality: {
            tableCount: 1,
            transactionTableCount: 1,
            rowCount: 1,
            rowContinuity: 1,
            resolvedRoles: ["date", "description", "amount", "balance"],
            joinedRowCount: 0,
            droppedFurnitureCount: 0,
          },
        },
      },
    }) as never,
  );
  assert.equal(withStructured.extractionFormatVersion, 2);
  assert.equal(withStructured.structuredProvider, "azure_di");
  assert.equal(withStructured.structuredPageCount, 1);
  assert.equal(withStructured.structuredRowCount, 1);
  assert.equal(withStructured.structuredRowContinuity, 1);
  assert.equal(withStructured.preExtractedRows?.length, 1);
  const serialized = JSON.stringify(withStructured.structuredDiagnostics);
  assert.ok(!serialized.includes("Payment"), "diagnostics must not contain raw statement content");
  assert.ok(!serialized.includes("01 Jan"));
});

test("buildWorkerInput omits structured fields when structured rows are absent", () => {
  const absent = buildWorkerInput(
    pipelineResult({
      merged: {
        parser: "azure_di",
        pageCount: 1,
        pages: [],
        combinedText: "text-only path",
        transactions: [{ debit: 100 }],
        metadata: {},
        warnings: [],
        structured: {
          tables: [],
          rows: [],
          layout: [],
          pageMeta: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 0 }],
          quality: {
            tableCount: 0,
            transactionTableCount: 0,
            rowCount: 0,
            rowContinuity: 0,
            resolvedRoles: [],
            joinedRowCount: 0,
            droppedFurnitureCount: 0,
          },
        },
      },
    }) as never,
  );
  assert.equal(absent.extractionFormatVersion, undefined);
  assert.equal(absent.preExtractedRows, undefined);
  assert.equal(absent.structuredDiagnostics, undefined);
});

test("extractionProcessingMetadata maps the stored fields", () => {
  const ok = extractionProcessingMetadata(pipelineResult() as never);
  assert.equal(ok.selectedParser, "pdfplumber");
  assert.equal(ok.extractionConfidence, 85);
  assert.equal(ok.detectedPdfType, "digital");
  assert.equal(ok.validationStatus, "valid");
  assert.equal(ok.reconciliationDifference, 0);

  const review = extractionProcessingMetadata(pipelineResult({
    ocrUsed: true,
    parserMethod: "ocr",
    validation: { valid: false, requiresReview: true, checks: [], expectedClosingBalance: 850, calculatedClosingBalance: 1200, difference: 350, missingTransactionCount: 3 },
    requiresReview: true,
  }) as never);
  assert.equal(review.validationStatus, "review_required");
  assert.equal(review.ocrUsed, true);
  assert.equal(review.reconciliationDifference, 350);
  assert.equal(review.missingTransactionCount, 3);
});

test("parserMethodLabel renders the Processed-with message", () => {
  assert.equal(parserMethodLabel("pdfjs"), "Processed with PDF.js");
  assert.equal(parserMethodLabel("pdfplumber"), "Processed with pdfplumber");
  assert.equal(parserMethodLabel("ocr"), "Processed with OCR");
  assert.equal(parserMethodLabel("mistral_ocr"), "Processed with Mistral OCR");
  assert.equal(parserMethodLabel("hybrid"), "Processed with hybrid extraction");
});

test("migration 017 adds the OCR-engine provenance columns", () => {
  const sql = read("supabase/migrations/017_ocr_engine.sql");
  for (const column of ["ocr_engine", "extraction_strategy", "acceptance_verdict", "ocr_engine_comparison"]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}\\b`), `migration must add ${column}`);
  }
  // Additive and safe to apply before/after the code ships.
  assert.match(sql, /alter table if exists/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});

// ── Merge coherence: text and transactions must come from the SAME parser ─────

function pageOf(text: string, pageNumber = 1) {
  return { pageNumber, text, words: [], tables: [], lines: [] };
}

function analysisFor(pageCount: number) {
  return {
    pageCount,
    totalTextLength: 4000,
    averageTextPerPage: Math.round(4000 / pageCount),
    pages: Array.from({ length: pageCount }, (_, i) => ({ pageNumber: i + 1, textLength: 1000, hasText: true })),
    isDigitalPdf: true,
    kind: "digital",
    needsOcr: false,
    confidence: 90,
    extractedText: "",
    reasons: [],
    characters: 4000,
    averageCharsPerPage: Math.round(4000 / pageCount),
  } as never;
}

// pdfplumber: plain fixed-column text that parses into rows.
function plumberWithRows(rows = 70) {
  const lines = Array.from({ length: rows }, (_, i) => `0${(i % 9) + 1}/02/2026 PURCHASE ${i + 1} 10.00 ${(10000 - 10 * (i + 1)).toFixed(2)}`);
  const combinedText = lines.join("\n");
  return {
    parser: "pdfplumber",
    pageCount: 4,
    pages: [0, 1, 2, 3].map((p) => pageOf(lines.slice(p * 18, (p + 1) * 18).join("\n"), p + 1)),
    combinedText,
    transactions: lines.map((raw, i) => ({ date: `2026-02-0${(i % 9) + 1}`, description: `PURCHASE ${i + 1}`, debit: 10, credit: null, balance: 10000 - 10 * (i + 1), raw })),
    metadata: { openingBalance: 10000, closingBalance: 10000 - 10 * rows },
    warnings: [],
  } as never;
}

// Mistral: verbose markdown for every page, but zero parsed transactions —
// longer than pdfplumber's text and with full page coverage, so under the old
// rule it won `textSource` and its markdown was sent to the accounting worker.
function mistralMarkdownNoRows() {
  const md = Array.from({ length: 4 }, (_, p) =>
    `# Statement page ${p + 1}\n\n| Date | Description | Amount | Balance |\n| --- | --- | --- | --- |\n${"| ... | ... | ... | ... |\n".repeat(40)}`,
  );
  return {
    parser: "mistral_ocr",
    pageCount: 4,
    pages: md.map((text, i) => pageOf(text, i + 1)),
    combinedText: md.join("\f"),
    transactions: [],
    metadata: { closingBalance: 12345 },
    warnings: [],
    confidence: 91,
    confidenceSource: "mistral-page",
  } as never;
}

test("merged text comes from the parser that produced the transactions", () => {
  const plumber = plumberWithRows(70);
  const mistral = mistralMarkdownNoRows();
  // Precondition: the OCR text really is longer, so this pins the actual bug.
  assert.ok(mistral.combinedText.length > plumber.combinedText.length, "fixture must reproduce the longer-OCR-text case");

  const { merged } = mergeExtractionResults(analysisFor(4), { pdfplumber: plumber, mistral });

  assert.equal(merged.transactions.length, 70);
  assert.equal(merged.combinedText, plumber.combinedText, "text must match the source of the transactions");
  assert.ok(!merged.combinedText.includes("| --- |"), "must not hand OCR markdown to the accounting worker");
  assert.deepEqual(merged.pages, plumber.pages, "pages must be coherent with the text too");
});

test("merged balances come from the parser that produced the transactions", () => {
  // Mistral reports a different closing balance. Taking its figure while keeping
  // pdfplumber's rows is what manufactures a large reconciliation difference.
  const { merged } = mergeExtractionResults(analysisFor(4), { pdfplumber: plumberWithRows(70), mistral: mistralMarkdownNoRows() });
  assert.equal(merged.metadata.openingBalance, 10000);
  assert.equal(merged.metadata.closingBalance, 10000 - 700, "must not adopt the other parser's closing balance");
});

test("other parsers may FILL a missing field but never override one", () => {
  const plumber = plumberWithRows(70) as unknown as { metadata: Record<string, unknown> };
  delete plumber.metadata.closingBalance; // pdfplumber missed it
  const { merged } = mergeExtractionResults(analysisFor(4), { pdfplumber: plumber as never, mistral: mistralMarkdownNoRows() });
  assert.equal(merged.metadata.openingBalance, 10000, "kept from the primary");
  assert.equal(merged.metadata.closingBalance, 12345, "filled from the other source since the primary had none");
});

test("with no transactions anywhere, the richest text still wins", () => {
  // Regression guard: a scanned document must not lose its OCR text just
  // because nothing parsed into rows.
  const empty = { parser: "pdfjs", pageCount: 4, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [] } as never;
  const mistral = mistralMarkdownNoRows();
  const { merged } = mergeExtractionResults(analysisFor(4), { pdfjs: empty, mistral });
  assert.equal(merged.combinedText, mistral.combinedText);
});

test("the worker picks statement text by parse yield, not by length", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /provided_rows = count_candidates\(provided\)/);
  assert.match(worker, /native_rows = count_candidates\(native_text\)/);
  assert.match(worker, /if provided and \(native_is_empty or provided_rows > native_rows\)/);
  // The old length rule must be gone.
  assert.ok(!/len\(provided\) >= max\(200, len\(native_text\) \/\/ 2\)/.test(worker), "length-based selection must not remain");
});

test("the yield counter matches the bank, so non-FNB statements are not counted blind", () => {
  const worker = read("workers/accounting_worker/main.py");
  // transaction_candidate_lines only enters a section after FNB's "Transactions
  // in RAND" heading, so on any other bank it returns 0 for both candidates and
  // the provided text loses 0 > 0 by default — which is how a Standard Bank
  // statement's 78,697-character Mistral extraction was discarded.
  assert.match(worker, /count_candidates = \(/, "the counter is selected, not hardcoded");
  assert.match(worker, /if preliminary_profile == FNB_PROFILE_ID/, "FNB keeps the FNB counter");
  assert.match(worker, /else generic_candidate_lines/, "everything else gets the bank-independent counter");
});

test("migration adds the processing-metadata columns", () => {
  const sql = read("supabase/migrations/013_extraction_pipeline_metadata.sql");
  for (const column of ["parser_method", "extraction_confidence", "detected_pdf_type", "ocr_used", "route_reason", "extraction_warnings", "validation_status", "reconciliation_difference", "missing_transaction_count", "requires_review"]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}\\b`), `migration must add ${column}`);
  }
});

test("route surfaces the real reason and parser debug on worker failure", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  // Passes the debug to the worker and logs content-free diagnostics before the call.
  assert.match(route, /extraction_debug: debug/, "passes extraction debug to the worker");
  // The route used to log the first 1000 chars of the extracted text. That is a
  // document-content leak into the log stream, so only LENGTHS are logged now —
  // matching the redaction discipline the rest of the pipeline follows.
  assert.ok(!/preExtractedTextSample/.test(route), "must not log a sample of the extracted document text");
  assert.match(route, /preExtractedTextLength: workerInput\.preExtractedText\.length/, "logs the length instead");
  // Overrides the generic message with the real reason, and returns parserDebug.
  assert.match(route, /pipelineDebug\?\.reasonNoTransactions/);
  assert.match(route, /error = pipelineDebug\.reasonNoTransactions/);
  assert.match(route, /parserDebug:/);
  assert.match(route, /pre_extracted_text_length: pipelineDebug\.preExtractedTextLength/);
});

test("pipeline forces OCR on near-empty PDF.js and reports the real reason", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /route\.force_ocr/, "forces OCR when PDF.js returns almost no text");
  assert.match(pipeline, /OCR completed but no readable text was found/, "specific OCR-empty reason");
  assert.match(pipeline, /reasonNoTransactions/);
});

test("pipeline distinguishes OCR-not-configured from OCR-ran-empty", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  // extractWithOcr returns null only when unconfigured; the pipeline must not
  // claim "OCR completed but no readable text" when OCR never ran.
  assert.match(pipeline, /ocrAttempted/, "tracks whether OCR was attempted");
  assert.match(pipeline, /const ocrConfigured = !\(ocrAttempted && ocr === null\)/);
  assert.match(pipeline, /not configured — set CONVERSION_WORKER_URL/, "honest not-configured reason");
});

test("worker logs pre_extracted_text and adds parser_debug to the 422", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /worker\.pre_extracted_text_received/);
  assert.match(worker, /worker\.pre_extracted_rows_received/);
  assert.match(worker, /worker\.pre_extracted_text_rejected/);
  assert.match(worker, /"parser_debug": parser_debug/);
  assert.match(worker, /"reason_no_transactions"/);
  // pre_extracted_text remains the active parser input path.
  assert.match(worker, /provided = \(payload\.pre_extracted_text or ""\)\.strip\(\)/);
  assert.ok(!/payload\.pre_extracted_rows[^\n]*transaction_candidate_lines/.test(worker), "structured rows must not alter text selection yet");
});

test("process route auto-runs the pipeline before the worker with a safe fallback", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /runExtractionPipeline/, "route runs the extraction pipeline");
  assert.match(route, /runPipelineBeforeWorker\(context, detail,/, "pipeline runs before the worker call");
  // Persists the metadata columns.
  assert.match(route, /parser_method: meta\.selectedParser/);
  assert.match(route, /requires_review: pipeline\.requiresReview/);
  // Passes the best text to the worker, keeping the PDF as fallback.
  assert.match(route, /hints\.pre_extracted_text = workerInput\.preExtractedText/);
  // Structured payload is additive and maps camelCase -> snake_case at HTTP boundary.
  assert.match(route, /hints\.extraction_format_version = workerInput\.extractionFormatVersion/);
  assert.match(route, /hints\.pre_extracted_rows = workerInput\.preExtractedRows/);
  assert.match(route, /hints\.structured_provider = workerInput\.structuredProvider/);
  assert.match(route, /hints\.structured_row_continuity = workerInput\.structuredRowContinuity/);
  assert.match(route, /hints\.structured_page_count = workerInput\.structuredPageCount/);
  assert.match(route, /hints\.structured_row_count = workerInput\.structuredRowCount/);
  assert.match(route, /hints\.structured_diagnostics = workerInput\.structuredDiagnostics/);
  // Safe fallback: pipeline failure records a warning and continues.
  assert.match(route, /Extraction pipeline error/);
  assert.match(route, /using original worker path/);
});

function page(text: string, tables: string[][][] = []) {
  return { pageNumber: 1, text, words: [], tables: tables.map((rows) => ({ rows })), lines: [] };
}

function statementResult(parser: string, transactions: unknown[], metadata: Record<string, unknown>) {
  const text = ["Opening Balance 1,000.00 Cr", "01 Jan Payment 100.00 900.00 Cr", "Closing Balance 900.00 Cr"].join("\n");
  return {
    parser,
    pageCount: 1,
    pages: [page(text, [[["01 Jan", "Payment", "100.00", "900.00 Cr"]]])],
    combinedText: text,
    transactions,
    metadata,
    warnings: [] as string[],
  };
}

test("analyzeExtraction returns the full analysis shape and routes OCR", () => {
  const digital = { parser: "pdfjs", pageCount: 2, pages: [page("x".repeat(400)), page("y".repeat(400))], combinedText: "x".repeat(400) + "\n" + "y".repeat(400), transactions: [], metadata: {}, warnings: [] };
  const analysis = analyzeExtraction(digital as never);
  assert.equal(analysis.kind, "digital");
  assert.equal(analysis.isDigitalPdf, true);
  assert.equal(analysis.needsOcr, false);
  assert.equal(analysis.pageCount, 2);
  assert.equal(analysis.totalTextLength, digital.combinedText.trim().length);
  assert.ok(analysis.averageTextPerPage > 0);
  assert.equal(analysis.pages.length, 2);
  assert.equal(analysis.pages[0].hasText, true);
  assert.ok(analysis.confidence >= 80, `digital confidence should be high, got ${analysis.confidence}`);
  assert.equal(analysis.extractedText, digital.combinedText);

  const scanned = { parser: "pdfjs", pageCount: 3, pages: [page(""), page(""), page("")], combinedText: "", transactions: [], metadata: {}, warnings: [] };
  const scannedAnalysis = analyzeExtraction(scanned as never);
  assert.equal(scannedAnalysis.kind, "scanned");
  assert.equal(scannedAnalysis.isDigitalPdf, false);
  assert.equal(scannedAnalysis.needsOcr, true);
  assert.ok(scannedAnalysis.confidence <= 20, `scanned confidence should be low, got ${scannedAnalysis.confidence}`);
});

test("weak-text / scanned PDFs route to OCR", () => {
  // Weak-text: sparse text (avg 25–200 chars/page) -> OCR needed.
  const weakText = "x".repeat(150);
  const weak = { parser: "pdfjs", pageCount: 3, pages: [page(weakText), page(""), page("")], combinedText: weakText, transactions: [], metadata: {}, warnings: [] };
  const weakAnalysis = analyzeExtraction(weak as never);
  assert.equal(weakAnalysis.kind, "weak-text");
  assert.equal(weakAnalysis.needsOcr, true);

  // Near-empty (e.g. 2 characters) -> scanned -> OCR forced.
  const scanned = { parser: "pdfjs", pageCount: 4, pages: [page("hi"), page(""), page(""), page("")], combinedText: "hi", transactions: [], metadata: {}, warnings: [] };
  const scannedAnalysis = analyzeExtraction(scanned as never);
  assert.equal(scannedAnalysis.kind, "scanned");
  assert.equal(scannedAnalysis.needsOcr, true);
});

test("OCR extractor calls /api/ocr-text with logging and a timeout", () => {
  const ocr = read("lib/pdf/extractWithOcr.ts");
  assert.match(ocr, /\/api\/ocr-text/, "must call the /api/ocr-text endpoint (not /ocr-text)");
  assert.match(ocr, /ocr_started/, "logs request started, endpoint, file size");
  assert.match(ocr, /textLength: combinedText\.trim\(\)\.length/, "logs OCR text LENGTH (count), not text");
  assert.doesNotMatch(ocr, /sample:\s*combinedText/, "must NOT log the OCR'd document text");
  assert.match(ocr, /errorBody/, "logs OCR error body on failure");
  assert.match(ocr, /AbortController/, "has a timeout");
});

test("OCR endpoint: binary health, fallback chain, exact reasons, full debug", () => {
  // The OCR implementation now lives in the shared engine (used by BOTH the HTTP
  // route and the in-process worker path); the route keeps auth + the GET handler.
  const engine = read("lib/pdf/ocrEngine.ts");
  const route = read("app/api/ocr-text/route.ts");
  // Returns the required response shape.
  for (const field of ["text", "pages", "confidence", "warnings"]) {
    assert.match(engine, new RegExp(`\\b${field}\\b`), `payload must carry ${field}`);
  }
  assert.match(engine, /OCR_TIMEOUT_MS/, "time-bounded so processing cannot hang");
  assert.match(route, /x-docucorex-worker-secret/, "worker-mode auth");
  // Task 3: GET binary health (which ocrmypdf/tesseract/gs + --list-langs).
  assert.match(route, /export async function GET/);
  assert.match(engine, /--list-langs/);
  assert.match(engine, /ghostscript: which\("gs"\)/);
  // Task 5: fallback chain force-ocr -> skip-text -> redo-ocr.
  assert.match(engine, /--force-ocr/);
  assert.match(engine, /--skip-text/);
  assert.match(engine, /--redo-ocr/);
  // Task 6: exact reason for encrypted / malformed / ghostscript.
  assert.match(engine, /encrypted \/ password-protected/);
  assert.match(engine, /malformed or unreadable/);
  // Task 8: full debug block with the required fields.
  for (const field of ["ocr_endpoint", "ocr_status", "ocr_exit_code", "ocr_stderr_sample", "sidecar_exists", "sidecar_size", "ocr_text_length"]) {
    assert.match(engine, new RegExp(field), `ocrDebug must include ${field}`);
  }
  // Task 4: logs content-type, file size, temp path, exit code, stderr, sidecar.
  assert.match(engine, /request received/);
  assert.match(engine, /wrote temp input/);
  // Dependencies are installed on the conversion worker.
  const dockerfile = read("workers/conversion_worker/Dockerfile");
  assert.match(dockerfile, /ocrmypdf/);
  assert.match(dockerfile, /tesseract-ocr/);
});

test("extractWithPdfjs is text-only, polyfills DOMMatrix, and never throws", async () => {
  const { extractWithPdfjs } = await import("@/lib/pdf/extractWithPdfjs.ts");
  // A non-PDF buffer must NOT throw — it returns an empty normalized result so the
  // pipeline can continue to pdfplumber / OCR (renderer-unavailable resilience).
  const result = await extractWithPdfjs(new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(result.parser, "pdfjs");
  assert.ok(Array.isArray(result.pages));
  assert.ok(Array.isArray(result.transactions));
  // DOMMatrix / Path2D / ImageData are polyfilled so pdf.js module init cannot
  // crash with "DOMMatrix is not defined" / "Cannot load @napi-rs/canvas".
  const g = globalThis as unknown as Record<string, unknown>;
  assert.notEqual(typeof g.DOMMatrix, "undefined", "DOMMatrix polyfilled");
  assert.notEqual(typeof g.Path2D, "undefined", "Path2D polyfilled");
  assert.notEqual(typeof g.ImageData, "undefined", "ImageData polyfilled");

  // Source-level guarantees: text-only options, no worker, no rasterisation, logs.
  const src = read("lib/pdf/extractWithPdfjs.ts");
  assert.match(src, /ensureNodeDomPolyfills/);
  assert.match(src, /getTextContent/);
  assert.doesNotMatch(src, /\.render\(/, "must not rasterise / call page.render");
  assert.match(src, /disableWorker: true/, "server worker disabled");
  assert.match(src, /isEvalSupported: false/);
  assert.match(src, /disableFontFace: true/);
  assert.doesNotMatch(src, /GlobalWorkerOptions\.workerSrc/, "must NOT set workerSrc in backend extraction");
  // Registers the worker handler on globalThis so pdf.js skips its broken
  // import("./pdf.worker.mjs") disk load in the serverless bundle.
  assert.match(src, /g\.pdfjsWorker = await import\("pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs"\)/);
  assert.match(src, /pdfjs_server_worker_disabled/);
  assert.match(src, /pdfjs_text_extracted/);
});

test("buffer handoff: PDF.js does not detach the caller's buffer (OCR runs after)", async () => {
  const { extractWithPdfjs } = await import("@/lib/pdf/extractWithPdfjs.ts");
  // %PDF header + junk. PDF.js runs first and may transfer/detach ITS buffer, but
  // it must receive a private copy so the caller's buffer stays valid for OCR.
  const original = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]);
  await extractWithPdfjs(original);
  assert.equal(original.byteLength, 9, "PDF.js must NOT detach the caller's buffer");
  // The OCR/pdfplumber handoff builds a Blob from a fresh copy — must not throw
  // "slice on a detached ArrayBuffer".
  assert.doesNotThrow(() => new Blob([new Uint8Array(original)]), "OCR handoff must not throw on the reused buffer");

  // Source guarantees: fresh copies per extractor + byte logs.
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /function copyBuffer/);
  assert.match(pipeline, /extractWithPdfjs\(pdfjsBuf\)/);
  assert.match(pipeline, /extractWithPdfplumber\(pdfplumberBuf/);
  assert.match(pipeline, /extractWithOcr\(ocrBuf/);
  assert.match(pipeline, /original_bytes: originalBytes, pdfjs_bytes: pdfjsBytes, pdfplumber_bytes: pdfplumberBytes, ocr_bytes: ocrBytes/);
  assert.match(read("lib/pdf/extractWithPdfjs.ts"), /const pdfData = new Uint8Array\(buffer\)/, "PDF.js copies before getDocument");
  assert.match(read("lib/pdf/extractWithOcr.ts"), /const ocrBytes = new Uint8Array\(buffer\)/, "OCR builds body from a fresh copy");
  assert.doesNotMatch(read("lib/pdf/extractWithOcr.ts"), /buffer\.slice\(\)/, "OCR must not slice a possibly-detached buffer");
});

test("process route returns immediately and runs extraction in the background", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  // Heavy work is scheduled after the response, not awaited on the request path.
  assert.match(route, /import \{ NextResponse, after \}/, "uses after() from next/server");
  assert.match(route, /after\(\(\) => processStatementInBackground\(/, "schedules background work");
  assert.match(route, /return NextResponse\.json\(\{ ok: true, status: "processing", runId, jobId/, "returns immediately with status/runId/jobId");
  // The pipeline + worker call live INSIDE the background function, not the POST path.
  assert.match(route, /async function processStatementInBackground/);
  assert.match(route, /export const maxDuration = 300/, "allows background work to finish");
  // Timeout protection / parser time budgets (Req 2).
  assert.match(route, /ACCOUNTING_WORKER_TIMEOUT_MS = 120_000/, "accounting worker 120s timeout");
  assert.match(read("lib/pdf/extractWithPdfplumber.ts"), /PDFPLUMBER_TIMEOUT_MS = 15_000/, "pdfplumber 15s timeout");
  assert.match(read("lib/pdf/extractWithOcr.ts"), /OCR_FETCH_TIMEOUT_MS = readTimeoutMs\([^)]*, 120_000\)/, "OCR 120s timeout (< maxDuration)");
  // Failures mark the run failed with the real error.
  assert.match(route, /failRun/, "updates run/job status to failed on error");
});

test("UI polls the run until a terminal state instead of holding the request", () => {
  const poll = read("lib/accounting/poll-run.ts");
  assert.match(poll, /pollRunUntilTerminal/);
  assert.match(poll, /\/api\/accounting\/fnb\/runs\//, "polls the run status endpoint");
  assert.match(poll, /"completed", "failed", "review", "cancelled"/, "stops on terminal states");
  for (const f of ["components/accounting/accounting-intelligence.tsx", "components/accounting/statement-workspace.tsx"]) {
    assert.match(read(f), /pollRunUntilTerminal/, `${f} polls for completion`);
  }
});

test("pipeline is fault-tolerant: pdfplumber and OCR run even if PDF.js fails", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  // pdfplumber ALWAYS runs (independent of PDF.js), so a PDF.js failure can never
  // silently skip native parsing — its text feeds the OCR decision.
  assert.match(pipeline, /pdfplumber ALWAYS runs, independent of PDF\.js/);
  assert.match(pipeline, /pdfplumber = await extractWithPdfplumber\(pdfplumberBuf, fileName\);/);
  // OCR routing is evidence-based (decideOcrNeed) on the BEST native text from
  // PDF.js OR pdfplumber: readable text skips OCR, but when neither extractor
  // recovers usable text (scanned/sparse/corrupt) OCR still runs.
  assert.match(pipeline, /decideOcrNeed\(\{/);
  assert.match(read("lib/pdf/ocrDecision.ts"), /best < READABLE_MIN_CHARS/);
  assert.match(read("lib/pdf/ocrDecision.ts"), /recovered by pdfplumber/);
  // Per-stage diagnostics + completion log, never abort early.
  assert.match(pipeline, /stages\.push\(stageDiag\("pdfjs"/);
  assert.match(pipeline, /stages\.push\(stageDiag\("pdfplumber"/);
  assert.match(pipeline, /stages\.push\(stageDiag\("ocr"/);
  assert.match(pipeline, /pipeline_completed/);
  // Stage logs from each extractor.
  assert.match(read("lib/pdf/extractWithPdfplumber.ts"), /pdfplumber_started/);
  assert.match(read("lib/pdf/extractWithPdfplumber.ts"), /pdfplumber_finished/);
  assert.match(read("lib/pdf/extractWithOcr.ts"), /ocr_started/);
  assert.match(read("lib/pdf/extractWithOcr.ts"), /ocr_finished/);
});

test("parserDebug reports which extractor succeeded and why others failed", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /stages: pipelineDebug\.stages/, "parserDebug carries per-stage outcomes");
});

test("conversion worker Dockerfile builds the checked-out commit (no stale git clone)", () => {
  const dockerfile = read("workers/conversion_worker/Dockerfile");
  assert.doesNotMatch(dockerfile, /git clone/, "must not clone the repo inside the image (permanent cache layer)");
  assert.match(dockerfile, /COPY \. \/app/, "uses Render's build context so new commits invalidate the layer");
  assert.match(dockerfile, /ls -la app\/api\/ocr-text/, "logs the route dir at build time");
  assert.match(dockerfile, /test -f app\/api\/ocr-text\/route\.ts/, "hard guard: build fails if /api/ocr-text is missing");
  assert.match(dockerfile, /pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /pnpm build/);
});

test("OCR debug propagates through the extractor and process route", () => {
  const extractor = read("lib/pdf/extractWithOcr.ts");
  assert.match(extractor, /_ocrDebug/, "extractor carries the OCR engine debug");
  assert.match(extractor, /_ocrReason/, "extractor carries the OCR reason");
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /ocr: ocrDebug/, "pipeline surfaces the OCR debug");
  assert.match(pipeline, /reasonNoTransactions = ocrReason \|\|/, "prefers the OCR engine's exact reason");
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /ocr: pipelineDebug\.ocr/, "parserDebug includes the OCR engine diagnostics");
});

test("scoreExtraction rewards transaction rows, balances and coverage", () => {
  const score = scoreExtraction(statementResult("pdfplumber", [{ date: "01 Jan", debit: 100, balance: 900 }], { openingBalance: 1000, closingBalance: 900 }) as never);
  assert.ok(score.transactionRows >= 1, "detects a transaction row");
  assert.ok(score.openingBalanceFound && score.closingBalanceFound, "detects opening/closing balances");
  assert.ok(score.score > 0);
});

test("validateBankStatement reconciles and flags review when it does not", () => {
  const ok = validateBankStatement(statementResult("hybrid", [{ debit: 100, credit: null }], { openingBalance: 1000, closingBalance: 900 }) as never);
  assert.equal(ok.valid, true);
  assert.equal(ok.requiresReview, false);
  assert.equal(ok.difference, 0);

  const bad = validateBankStatement(statementResult("hybrid", [{ debit: 100, credit: null }], { openingBalance: 1000, closingBalance: 500 }) as never);
  assert.equal(bad.valid, false);
  assert.equal(bad.requiresReview, true);
  assert.equal(bad.difference, 400); // calculated 900 vs declared 500
  assert.ok(bad.checks.some((c: { rule: string; ok: boolean }) => c.rule === "reconciliation" && !c.ok));
});

// ── Speed-optimisation: fast routing, budgets, cache, OCR cost, fallback ──────

test("digital PDF (>500 chars) skips OCR; scanned (<=20 chars) routes straight to OCR", () => {
  // Analysis-level: a dense digital PDF needs no OCR; an empty scanned one does.
  const digital = { parser: "pdfjs", pageCount: 2, pages: [page("x".repeat(400)), page("y".repeat(400))], combinedText: "x".repeat(400) + "\n" + "y".repeat(400), transactions: [], metadata: {}, warnings: [] };
  assert.equal(analyzeExtraction(digital as never).needsOcr, false, "digital text layer skips OCR");
  const scanned = { parser: "pdfjs", pageCount: 3, pages: [page(""), page(""), page("")], combinedText: "", transactions: [], metadata: {}, warnings: [] };
  assert.equal(analyzeExtraction(scanned as never).kind, "scanned");

  // The ad-hoc skipOcrFastPath / scannedFastPath booleans have been replaced by
  // one named strategy decision. Assert the BEHAVIOUR rather than the constants:
  // a dense digital layer must not run OCR upfront; a scanned one must.
  assert.equal(selectExtractionStrategy(analyzeExtraction(digital as never)).ocrUpfront, false, "digital text layer skips OCR");
  assert.equal(selectExtractionStrategy(analyzeExtraction(scanned as never)).ocrUpfront, true, "scanned PDF routes to OCR");
  assert.equal(selectExtractionStrategy(analyzeExtraction(scanned as never)).strategy, "ocr_primary");

  // pdfplumber ALWAYS runs so OCR routing has both extractors' evidence.
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /pdfplumber ALWAYS runs, independent of PDF\.js/);
  assert.match(pipeline, /pdfplumber = await extractWithPdfplumber\(pdfplumberBuf, fileName\);/);
});

test("pipeline enforces per-parser time budgets (Req 2)", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /PDFJS_BUDGET_MS = 10_000/, "PDF.js 10s budget");
  assert.match(pipeline, /withTimeout\(extractWithPdfjs\(pdfjsBuf\)/, "PDF.js is time-boxed");
  assert.match(read("lib/pdf/extractWithPdfplumber.ts"), /PDFPLUMBER_TIMEOUT_MS = 15_000/, "pdfplumber 15s");
  assert.match(read("lib/pdf/extractWithOcr.ts"), /OCR_FETCH_TIMEOUT_MS = readTimeoutMs\([^)]*, 120_000\)/, "OCR 120s");
  assert.match(read("app/api/accounting/fnb/process/route.ts"), /ACCOUNTING_WORKER_TIMEOUT_MS = 120_000/, "accounting worker 120s");
});

test("extraction cache reuses by document_id + file_hash; Force reprocess bypasses it", () => {
  clearExtractionCache();
  const hash = computeFileHash(new Uint8Array([1, 2, 3, 4]));
  assert.equal(hash, computeFileHash(new Uint8Array([1, 2, 3, 4])), "hash is stable for identical bytes");
  assert.notEqual(hash, computeFileHash(new Uint8Array([1, 2, 3, 5])), "hash differs for different bytes");
  assert.equal(getCachedExtraction("doc1", hash), null, "cold cache misses");

  const result = { parserMethod: "ocr", ocrUsed: true } as never;
  setCachedExtraction("doc1", hash, result);
  assert.equal(getCachedExtraction("doc1", hash), result, "reuses the cached OCR/extraction result");
  assert.equal(getCachedExtraction("doc2", hash), null, "different document misses");
  assert.equal(getCachedExtraction("doc1", "deadbeef"), null, "different bytes miss");
  assert.equal(getCachedExtraction("doc1", null), null, "missing hash never hits");

  // Force reprocess re-extracts: the pipeline only reads the cache when !force.
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /if \(!force\)/, "cache is consulted only when not forced");
  assert.match(pipeline, /getCachedExtraction\(documentId, fileHash\)/);
  assert.match(pipeline, /setCachedExtraction\(documentId, fileHash, result\)/);
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /computeFileHash\(buffer\)/, "route derives the file hash");
  assert.match(route, /force: options\.force/, "route threads force into the pipeline");
  assert.match(route, /Boolean\(body\.reprocess\)/, "Force reprocess maps to force");
});

test("the full native pipeline is never bypassed on a bad guess (Req 6)", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  // pdfplumber now ALWAYS runs (no scanned skip), so a PDF.js mis-classification
  // can never bypass native parsing — the fallback is satisfied by design.
  assert.match(pipeline, /pdfplumber ALWAYS runs, independent of PDF\.js/);
  assert.match(pipeline, /pdfplumber = await extractWithPdfplumber\(pdfplumberBuf, fileName\);/);
  // PDF.js is raced against a budget so a hang can never block the pipeline.
  assert.match(pipeline, /function withTimeout/);
  // parserDebug is preserved end-to-end (stages carry the skip/failure reasons).
  assert.match(pipeline, /const debug: ExtractionDebug = \{/);
});

test("OCR worker runs the fastest mode first and escalates only on failure (Req 4)", () => {
  const engine = read("lib/pdf/ocrEngine.ts");
  const skipIdx = engine.indexOf("--skip-text");
  const forceIdx = engine.indexOf("--force-ocr");
  const redoIdx = engine.indexOf("--redo-ocr");
  assert.ok(skipIdx > 0, "uses --skip-text");
  assert.ok(forceIdx > skipIdx, "--force-ocr comes after --skip-text (heavier recovery mode)");
  assert.ok(redoIdx > forceIdx, "--redo-ocr comes last");
  // Budgets are now resolved at call time in timeouts(); the defaults are unchanged.
  assert.match(engine, /const perAttempt = readTimeoutMs\([^)]*, 120_000\)/, "OCR per-attempt cap is 120s");
  assert.match(engine, /const total = readTimeoutMs\([^)]*, perAttempt\)/, "total OCR budget defaults to the per-attempt cap");
  assert.match(engine, /total OCR budget exhausted/, "stops escalating once the budget is spent");
  // Only escalates when the previous attempt produced no text.
  assert.match(engine, /if \(sidecarText\.trim\(\)\.length > 0\) \{\s*\n\s*text = sidecarText;\s*\n\s*break;/);
});

test("UI shows the processing steps, elapsed time, and long-processing notice (Req 5)", () => {
  const steps = read("lib/pdf/processingSteps.ts");
  for (const label of ["Detecting PDF type", "Running OCR", "Parsing transactions", "Reconciling"]) {
    assert.match(steps, new RegExp(label), `step label: ${label}`);
  }
  assert.match(steps, /Still processing — scanned PDFs can take longer/);
  const component = read("components/accounting/processing-steps.tsx");
  assert.match(component, /formatElapsed/, "renders an elapsed timer");
  assert.match(component, /LONG_PROCESSING_NOTICE/, "shows the long-processing notice");
  assert.match(component, /PROCESSING_STEP_ORDER/, "renders the ordered steps");
});

// ── OCR reliability (502 handling, controlled timeout, logging, caching) ──────

test("OCR worker runs the plain single-threaded command first (Req 5)", () => {
  const engine = read("lib/pdf/ocrEngine.ts");
  // First attempt: ocrmypdf -l eng --jobs 1 --sidecar ... (no mode flag).
  assert.match(engine, /\["-l", "eng", "--jobs", "1", "--sidecar"/, "plain --jobs 1 --sidecar command runs first");
  // --jobs 1 caps memory to avoid an OOM-triggered raw 502.
  assert.match(engine, /--jobs 1 caps memory/);
});

test("OCR endpoint returns a controlled 504 on timeout instead of crashing (Req 3/7/8)", () => {
  const engine = read("lib/pdf/ocrEngine.ts");
  const route = read("app/api/ocr-text/route.ts");
  // Detects a spawnSync timeout (SIGTERM / ETIMEDOUT) and returns a structured
  // result, not a crash.
  assert.match(engine, /result\.signal === "SIGTERM" \|\| \(result\.error as NodeJS\.ErrnoException \| undefined\)\?\.code === "ETIMEDOUT"/);
  assert.match(engine, /ocr_status: 504/, "controlled 504 status in ocrDebug");
  assert.match(engine, /OCR timed out — the PDF is too large/, "timeout reason carried in the payload");
  assert.match(engine, /status: 504,/, "engine reports 504, never a raw crash");
  // The route forwards the engine's status verbatim, so the HTTP contract holds.
  assert.match(route, /NextResponse\.json\(result\.body, \{ status: result\.status \}\)/);
  // Does not escalate to heavier modes after a timeout (Req 6).
  assert.match(engine, /A timeout is not a "clear content failure"/);
});

test("OCR endpoint logs the full lifecycle (Req 2)", () => {
  const engine = read("lib/pdf/ocrEngine.ts");
  for (const phrase of ["request received", "wrote temp input", "OCR command started", "OCR command finished"]) {
    assert.match(engine, new RegExp(phrase), `logs "${phrase}"`);
  }
  // exit code, stderr, sidecar size, text length are all logged on finish.
  assert.match(engine, /exitCode: result\.status/);
  assert.match(engine, /stderrSample: lastStderr/);
  assert.match(engine, /sidecarSize: sidecarSizeNow/);
  assert.match(engine, /textLength: sidecarText\.trim\(\)\.length/);
});

test("OCR client retries once on 502 then flags review (Req 9)", () => {
  const ocr = read("lib/pdf/extractWithOcr.ts");
  assert.match(ocr, /OCR_RETRY_ON_502_DELAY_MS = 5_000/, "retries after 5s");
  assert.match(ocr, /OCR_MAX_ATTEMPTS = 2/, "initial attempt + one retry");
  assert.match(ocr, /response\.status === 502 && attempt < OCR_MAX_ATTEMPTS/, "retry gated on 502");
  assert.match(ocr, /_ocrRequiresReview/, "persistent 502 is flagged for review");
  assert.match(ocr, /ocr\.retry/, "logs the retry");
  // Pipeline honours the review flag and surfaces it with parserDebug.ocr.
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /const ocrUnavailable = Boolean\(ocrText\?\.metadata\?\._ocrRequiresReview\)/);
  // Review is now driven by the single acceptance verdict — which subsumes the
  // old selection/validation checks and adds completeness + engine agreement.
  assert.match(pipeline, /const requiresReview = !assembled\.accepted \|\| ocrUnavailable/);
});

test("successful OCR is cached; unavailable OCR is not (so it can retry) (Req 10)", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /const extractionSucceeded = assembled\.merged\.combinedText\.trim\(\)\.length > 0 \|\| assembled\.merged\.transactions\.length > 0/);
  assert.match(pipeline, /if \(extractionSucceeded && !ocrUnavailable\) setCachedExtraction/, "caches only successful extractions");
  assert.match(pipeline, /pipeline_cache_skipped/, "logs when a failed OCR is intentionally not cached");
});

// ── Status synchronization ────────────────────────────────────────────────────

test("deriveEffectiveRunStatus stops showing Processing once a run is really done", () => {
  assert.equal(deriveEffectiveRunStatus({ status: "processing", transactionCount: 5 }), "completed", "transactions ⇒ completed");
  assert.equal(deriveEffectiveRunStatus({ status: "processing", requiresReview: true }), "review", "requires_review ⇒ review");
  assert.equal(deriveEffectiveRunStatus({ status: "processing", validationStatus: "failed" }), "failed");
  assert.equal(deriveEffectiveRunStatus({ status: "processing", validationStatus: "review" }), "review");
  assert.equal(deriveEffectiveRunStatus({ status: "processing", validationStatus: "completed" }), "completed");
  assert.equal(deriveEffectiveRunStatus({ status: "processing", transactionCount: 0 }), "processing", "genuinely still processing");
  assert.equal(deriveEffectiveRunStatus({ status: "completed" }), "completed", "terminal passes through");
  assert.equal(isTerminalRunStatus("processing"), false);
  assert.equal(isTerminalRunStatus("review"), true);
});

test("status sync: poll stops on effective terminal; UI refreshes list and clears stale queue item", () => {
  const poll = read("lib/accounting/poll-run.ts");
  assert.match(poll, /deriveEffectiveRunStatus/, "poll uses the effective terminal state");
  assert.match(poll, /isTerminalRunStatus\(effective\)/);
  const intel = read("components/accounting/accounting-intelligence.tsx");
  assert.match(intel, /deriveEffectiveRunStatus\(run, run\.transactionCount\)/, "queue status uses the effective run status");
  assert.match(intel, /queue\.filter\(\(item\) => item\.runId !== runId\)/, "removes the stale upload-queue item once terminal");
  assert.match(intel, /if \(!outcome\.timedOut\) await refreshAccountingData\(runId/, "refreshes the list + summary on terminal");
});

// ── Failed-run visibility + diagnostics ──────────────────────────────────────

test("failed runs surface the real error + diagnostics with retry (not just 'Failed 0%')", () => {
  // parser/OCR debug is persisted on failure so the workspace can show WHY.
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /parser_debug: parserDebug \?\? null/, "persists parser/OCR debug on failure");
  assert.match(route, /migration 015 not applied/, "falls back if the column is missing");
  assert.match(read("supabase/migrations/015_parser_debug.sql"), /add column if not exists parser_debug jsonb/);
  assert.match(read("lib/accounting/server.ts"), /parserDebug: \(row\.parser_debug/, "run mapping exposes parserDebug");

  // The panel shows error, last step, selected parser, detected type, and both
  // debug blobs, plus a Retry / Force Reprocess control.
  const panel = read("components/accounting/failed-run-panel.tsx");
  assert.match(panel, /run\.error/);
  assert.match(panel, /Last processing step/);
  assert.match(panel, /Selected parser/);
  assert.match(panel, /Detected PDF type/);
  assert.match(panel, /OCR debug/);
  assert.match(panel, /Parser debug/);
  assert.match(panel, /"Retry"/);
  assert.match(panel, /Force Reprocess/);

  // Dashboard renders the failed panel (not the empty state), a "View error"
  // affordance, and retry force-reprocesses. Failed runs stay selectable.
  const intel = read("components/accounting/accounting-intelligence.tsx");
  assert.match(intel, /detail\.run\.status === "failed" \? \(/, "failed status renders the panel");
  assert.match(intel, /<FailedRunPanel/);
  assert.match(intel, /onRetry=\{\(\) => void processRun\(detail\.run\.id, \{ reprocess: true \}\)\}/, "retry force-reprocesses");
  assert.match(intel, /View error/, "list exposes a View error affordance on failed runs");
});

// ── PDF viewer render-race fix ────────────────────────────────────────────────

test("document viewer cancels the previous render before starting a new one", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /renderSeqRef/, "incrementing render sequence id");
  assert.match(viewer, /const seq = \+\+renderSeqRef\.current/, "each render claims the latest id");
  assert.match(viewer, /previous\.cancel\(\)/, "cancels the in-flight render task");
  assert.match(viewer, /await previous\.promise/, "awaits the cancellation before re-rendering");
  assert.match(viewer, /isRenderingCancelled/, "ignores RenderingCancelledException");
  assert.match(viewer, /if \(seq !== renderSeqRef\.current\) return/, "only the latest render mutates canvas/state");
  assert.match(viewer, /disabled=\{rendering\}/, "Retry disabled while a render is running");
  // Unmount cleanup cancels the task and destroys the document.
  assert.match(viewer, /renderTaskRef\.current\?\.cancel\(\)/);
  assert.match(viewer, /void pdfRef\.current\?\.destroy\(\)/);
});

test("mergeExtractionResults prefers pdfplumber transactions and flags disagreement", () => {
  const analysis = { pageCount: 1, characters: 100, averageCharsPerPage: 100, kind: "digital" as const, needsOcr: false, reasons: [] };
  const pdfjs = statementResult("pdfjs", [{ debit: 100 }], { openingBalance: 1000, closingBalance: 900 });
  const pdfplumber = statementResult("pdfplumber", [{ debit: 100 }, { debit: 50 }, { debit: 25 }, { debit: 10 }, { debit: 5 }], { openingBalance: 1000, closingBalance: 900 });
  const { selection, merged } = mergeExtractionResults(analysis, { pdfjs: pdfjs as never, pdfplumber: pdfplumber as never });
  assert.equal(merged.transactions.length, 5, "transactions come from pdfplumber");
  assert.ok(["pdfplumber", "hybrid"].includes(selection.selectedParser));
  assert.ok(selection.extractionScores.pdfjs && selection.extractionScores.pdfplumber);

  // Disagreement on transaction count -> warning + review.
  const disagree = mergeExtractionResults(analysis, {
    pdfjs: statementResult("pdfjs", new Array(40).fill({ debit: 1 }), { closingBalance: 900 }) as never,
    pdfplumber: statementResult("pdfplumber", new Array(10).fill({ debit: 1 }), { closingBalance: 500 }) as never,
  });
  assert.ok(disagree.selection.warnings.some((w: string) => /disagree/i.test(w)), "flags disagreement");
  assert.equal(disagree.selection.requiresReview, true);
});

// ── Confidence calculation bugs (regression guards) ───────────────────────────

test("PDF.js disagreeing with a table parser does not fine the extraction", () => {
  // The reported case: pdfplumber extracted the statement correctly and it
  // reconciled at R0.00, but PDF.js — a raw text-layer probe — read different
  // counts and balances. Four detectors fired at 15 points each and a ~98 score
  // was reported as 38.
  const plumber = plumberWithRows(70);
  const weakPdfjs = {
    parser: "pdfjs",
    pageCount: 4,
    pages: [pageOf("garbled text layer 01/02/2026 10.00", 1)],
    combinedText: "garbled text layer 01/02/2026 10.00",
    transactions: [{ date: "2026-02-01", description: "PARTIAL", debit: 10, credit: null, balance: 1 }],
    metadata: { openingBalance: 1, closingBalance: 2 },
    warnings: [],
  } as never;

  const { selection } = mergeExtractionResults(analysisFor(4), { pdfplumber: plumber, pdfjs: weakPdfjs });
  assert.deepEqual(selection.disagreements, [], "PDF.js is not a peer — its differences are not conflicts");
  assert.ok(selection.confidence > 60, `a correct extraction must not be fined into review, got ${selection.confidence}`);
});

test("disagreement between real peers is still recorded and still penalised", () => {
  const tesseract = plumberWithRows(70) as unknown as Record<string, unknown>;
  tesseract.parser = "ocr";
  const mistral = plumberWithRows(40) as unknown as Record<string, unknown>;
  mistral.parser = "mistral_ocr";
  mistral.metadata = { openingBalance: 10000, closingBalance: 5555 };

  const { selection } = mergeExtractionResults(analysisFor(4), { ocr: tesseract as never, mistral: mistral as never });
  assert.ok(selection.disagreements.length > 0, "two OCR engines contradicting each other IS a conflict");
  assert.equal(selection.requiresReview, true, "any disagreement still forces review");
});

test("the compounded penalty is capped", () => {
  const { DISAGREEMENT_PENALTY_PER_WARNING, MAX_DISAGREEMENT_PENALTY } = mergeModule;
  assert.equal(DISAGREEMENT_PENALTY_PER_WARNING, 15);
  assert.equal(MAX_DISAGREEMENT_PENALTY, 30);
  const src = read("lib/pdf/mergeExtractionResults.ts");
  assert.match(src, /Math\.min\(MAX_DISAGREEMENT_PENALTY, warnings\.length \* DISAGREEMENT_PENALTY_PER_WARNING\)/);
});

test("the worker weights reconciliation checks by their real key", () => {
  const worker = read("workers/accounting_worker/main.py");
  // validate_extraction builds checks keyed by "name"; reading "rule" made every
  // weight fall through to the default, so the weighting table was inert.
  assert.match(worker, /weights\.get\(str\(c\.get\("name"\)\), 5\)/);
  assert.ok(!/weights\.get\(str\(c\.get\("rule"\)\), 5\)/.test(worker), "the 'rule' key must be gone");
  // The failed-rules penalty read the wrong key too.
  assert.match(worker, /rules = extraction_check\.get\("failures"\)/);
  assert.ok(!/extraction_check\.get\("failed_rules"\)/.test(worker));
  // The weighting that was inert must still be present and meaningful.
  assert.match(worker, /"reconciliation": 50/);
});

test("PDF.js finding MORE rows than the winner is still flagged", () => {
  // The asymmetry: fewer rows from a text-layer probe is expected noise, but
  // more rows means the winner may have dropped data — that must not be hidden.
  const plumber = plumberWithRows(10);
  const richPdfjs = {
    parser: "pdfjs",
    pageCount: 4,
    pages: [pageOf("x".repeat(200), 1)],
    combinedText: "x".repeat(200),
    transactions: Array.from({ length: 60 }, (_, i) => ({ date: `2026-02-0${(i % 9) + 1}`, description: `ROW ${i}`, debit: 10, credit: null, balance: 100 - i })),
    metadata: { openingBalance: 10000, closingBalance: 9900 },
    warnings: [],
  } as never;
  const { selection } = mergeExtractionResults(analysisFor(4), { pdfplumber: plumber, pdfjs: richPdfjs });
  assert.ok(selection.disagreements.length > 0, "the winner may have dropped rows — flag it");
  assert.equal(selection.requiresReview, true);
});

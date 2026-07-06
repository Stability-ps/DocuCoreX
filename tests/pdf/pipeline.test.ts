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
const { mergeExtractionResults } = await import("@/lib/pdf/mergeExtractionResults.ts");
const { validateBankStatement } = await import("@/lib/accounting/validateBankStatement.ts");
const { buildWorkerInput, extractionProcessingMetadata, parserMethodLabel } = await import("@/lib/pdf/workerHandoff.ts");

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
  assert.equal(parserMethodLabel("hybrid"), "Processed with hybrid extraction");
});

test("migration adds the processing-metadata columns", () => {
  const sql = read("supabase/migrations/013_extraction_pipeline_metadata.sql");
  for (const column of ["parser_method", "extraction_confidence", "detected_pdf_type", "ocr_used", "route_reason", "extraction_warnings", "validation_status", "reconciliation_difference", "missing_transaction_count", "requires_review"]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}\\b`), `migration must add ${column}`);
  }
});

test("route surfaces the real reason and parser debug on worker failure", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  // Passes the debug to the worker and logs it (with a text sample) before the call.
  assert.match(route, /extraction_debug: debug/, "passes extraction debug to the worker");
  assert.match(route, /preExtractedTextSample: workerInput\.preExtractedText\.slice\(0, 1000\)/, "logs first 1000 chars before the worker");
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

test("worker logs pre_extracted_text and adds parser_debug to the 422", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /worker\.pre_extracted_text_received/);
  assert.match(worker, /worker\.pre_extracted_text_rejected/);
  assert.match(worker, /"parser_debug": parser_debug/);
  assert.match(worker, /"reason_no_transactions"/);
});

test("process route auto-runs the pipeline before the worker with a safe fallback", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /runExtractionPipeline/, "route runs the extraction pipeline");
  assert.match(route, /runPipelineBeforeWorker\(context, detail\)/, "pipeline runs before the worker call");
  // Persists the metadata columns.
  assert.match(route, /parser_method: meta\.selectedParser/);
  assert.match(route, /requires_review: pipeline\.requiresReview/);
  // Passes the best text to the worker, keeping the PDF as fallback.
  assert.match(route, /hints\.pre_extracted_text = workerInput\.preExtractedText/);
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
  assert.match(ocr, /ocr\.request_started/, "logs request started, endpoint, file size");
  assert.match(ocr, /textLength: combinedText\.trim\(\)\.length/, "logs OCR text length");
  assert.match(ocr, /sample: combinedText\.trim\(\)\.slice\(0, 500\)/, "logs first 500 chars");
  assert.match(ocr, /errorBody/, "logs OCR error body on failure");
  assert.match(ocr, /AbortController/, "has a timeout");
});

test("conversion worker exposes an /api/ocr-text endpoint returning { text, pages, confidence, warnings }", () => {
  const route = read("app/api/ocr-text/route.ts");
  assert.match(route, /ocrmypdf/, "uses ocrmypdf");
  assert.match(route, /--sidecar/, "extracts OCR text via sidecar");
  assert.match(route, /NextResponse\.json\(\{ text, pages, confidence, warnings \}\)/, "returns the required shape");
  assert.match(route, /OCR_TIMEOUT_MS/, "time-bounded so processing cannot hang");
  assert.match(route, /x-docucorex-worker-secret/, "worker-mode auth");
  // Dependencies are installed on the conversion worker.
  const dockerfile = read("workers/conversion_worker/Dockerfile");
  assert.match(dockerfile, /ocrmypdf/);
  assert.match(dockerfile, /tesseract-ocr/);
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

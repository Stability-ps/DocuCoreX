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
  assert.match(worker, /worker\.pre_extracted_text_rejected/);
  assert.match(worker, /"parser_debug": parser_debug/);
  assert.match(worker, /"reason_no_transactions"/);
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
  assert.match(ocr, /textLength: combinedText\.trim\(\)\.length/, "logs OCR text length");
  assert.match(ocr, /sample: combinedText\.trim\(\)\.slice\(0, 500\)/, "logs first 500 chars");
  assert.match(ocr, /errorBody/, "logs OCR error body on failure");
  assert.match(ocr, /AbortController/, "has a timeout");
});

test("OCR endpoint: binary health, fallback chain, exact reasons, full debug", () => {
  const route = read("app/api/ocr-text/route.ts");
  // Returns the required response shape (text, pages, confidence, warnings, ...).
  assert.match(route, /text,\s*\n?\s*pages,\s*\n?\s*confidence,\s*\n?\s*warnings/, "returns text/pages/confidence/warnings");
  assert.match(route, /OCR_TIMEOUT_MS/, "time-bounded so processing cannot hang");
  assert.match(route, /x-docucorex-worker-secret/, "worker-mode auth");
  // Task 3: GET binary health (which ocrmypdf/tesseract/gs + --list-langs).
  assert.match(route, /export async function GET/);
  assert.match(route, /--list-langs/);
  assert.match(route, /ghostscript: which\("gs"\)/);
  // Task 5: fallback chain force-ocr -> skip-text -> redo-ocr.
  assert.match(route, /--force-ocr/);
  assert.match(route, /--skip-text/);
  assert.match(route, /--redo-ocr/);
  // Task 6: exact reason for encrypted / malformed / ghostscript.
  assert.match(route, /encrypted \/ password-protected/);
  assert.match(route, /malformed or unreadable/);
  // Task 8: full debug block with the required fields.
  for (const field of ["ocr_endpoint", "ocr_status", "ocr_exit_code", "ocr_stderr_sample", "sidecar_exists", "sidecar_size", "ocr_text_length"]) {
    assert.match(route, new RegExp(field), `ocrDebug must include ${field}`);
  }
  // Task 4: logs content-type, file size, temp path, exit code, stderr, sidecar.
  assert.match(route, /request received/);
  assert.match(route, /wrote temp input/);
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
  assert.match(read("lib/pdf/extractWithOcr.ts"), /OCR_FETCH_TIMEOUT_MS = 120_000/, "OCR 120s timeout");
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
  // pdfplumber is attempted for everything except the clearly-scanned fast path
  // (no text layer), so a PDF.js failure can never silently skip native parsing.
  assert.match(pipeline, /Stage 2 — pdfplumber\. Attempted for everything EXCEPT the clearly-scanned fast/);
  assert.match(pipeline, /pdfplumber = await extractWithPdfplumber\(pdfplumberBuf, fileName\);/);
  // OCR runs when native extraction is poor (0 tx / <20 chars) OR analysis says so.
  assert.match(pipeline, /nativeTransactions === 0 \|\| nativeChars < 20/);
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

  // Pipeline source: the fast-routing thresholds + skip decisions.
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /DIGITAL_TEXT_LAYER_MIN_CHARS = 500/);
  assert.match(pipeline, /SCANNED_TEXT_LAYER_MAX_CHARS = 20/);
  assert.match(pipeline, /const skipOcrFastPath = pdfjsChars > DIGITAL_TEXT_LAYER_MIN_CHARS/);
  assert.match(pipeline, /const scannedFastPath = pdfjsChars <= SCANNED_TEXT_LAYER_MAX_CHARS && analysis\.kind === "scanned"/);
  // Scanned fast path skips pdfplumber and records WHY, then goes to OCR.
  assert.match(pipeline, /scanned \/ no text layer — routed directly to OCR/);
  assert.match(pipeline, /digital text layer \(>500 chars\) — OCR skipped/);
});

test("pipeline enforces per-parser time budgets (Req 2)", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  assert.match(pipeline, /PDFJS_BUDGET_MS = 10_000/, "PDF.js 10s budget");
  assert.match(pipeline, /withTimeout\(extractWithPdfjs\(pdfjsBuf\)/, "PDF.js is time-boxed");
  assert.match(read("lib/pdf/extractWithPdfplumber.ts"), /PDFPLUMBER_TIMEOUT_MS = 15_000/, "pdfplumber 15s");
  assert.match(read("lib/pdf/extractWithOcr.ts"), /OCR_FETCH_TIMEOUT_MS = 120_000/, "OCR 120s");
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

test("optimized path falls back to the full pipeline (Req 6)", () => {
  const pipeline = read("lib/pdf/runExtractionPipeline.ts");
  // Scanned fast path skipped pdfplumber — if OCR is empty, run it after all.
  assert.match(pipeline, /route\.fallback_pdfplumber/);
  assert.match(pipeline, /scanned fast path OCR empty — running skipped native parser/);
  // PDF.js is raced against a budget so a hang can never block the fallback.
  assert.match(pipeline, /function withTimeout/);
  // parserDebug is preserved end-to-end (stages carry the skip/failure reasons).
  assert.match(pipeline, /const debug: ExtractionDebug = \{/);
});

test("OCR worker runs the fastest mode first and escalates only on failure (Req 4)", () => {
  const route = read("app/api/ocr-text/route.ts");
  const skipIdx = route.indexOf("--skip-text");
  const forceIdx = route.indexOf("--force-ocr");
  const redoIdx = route.indexOf("--redo-ocr");
  assert.ok(skipIdx > 0, "uses --skip-text");
  assert.ok(forceIdx > skipIdx, "--force-ocr comes after --skip-text (heavier recovery mode)");
  assert.ok(redoIdx > forceIdx, "--redo-ocr comes last");
  assert.match(route, /OCR_TOTAL_BUDGET_MS = 120_000/, "total OCR budget is 120s");
  assert.match(route, /total OCR budget exhausted/, "stops escalating once the budget is spent");
  // Only escalates when the previous attempt produced no text.
  assert.match(route, /if \(sidecarText\.trim\(\)\.length > 0\) \{\s*\n\s*text = sidecarText;\s*\n\s*break;/);
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
  const route = read("app/api/ocr-text/route.ts");
  // First attempt: ocrmypdf -l eng --jobs 1 --sidecar ... (no mode flag).
  assert.match(route, /\["-l", "eng", "--jobs", "1", "--sidecar"/, "plain --jobs 1 --sidecar command runs first");
  // --jobs 1 caps memory to avoid an OOM-triggered raw 502.
  assert.match(route, /--jobs 1 caps memory/);
});

test("OCR endpoint returns a controlled 504 on timeout instead of crashing (Req 3/7/8)", () => {
  const route = read("app/api/ocr-text/route.ts");
  // Detects a spawnSync timeout (SIGTERM / ETIMEDOUT) and returns JSON, not a 502.
  assert.match(route, /result\.signal === "SIGTERM" \|\| \(result\.error as NodeJS\.ErrnoException \| undefined\)\?\.code === "ETIMEDOUT"/);
  assert.match(route, /ocr_status: 504/, "controlled 504 status in ocrDebug");
  assert.match(route, /OCR timed out — the PDF is too large/, "timeout reason returned as JSON");
  assert.match(route, /status: 504 \}/, "responds 504, never a raw crash");
  // Does not escalate to heavier modes after a timeout (Req 6).
  assert.match(route, /A timeout is not a "clear content failure"/);
});

test("OCR endpoint logs the full lifecycle (Req 2)", () => {
  const route = read("app/api/ocr-text/route.ts");
  for (const phrase of ["request received", "wrote temp input", "OCR command started", "OCR command finished"]) {
    assert.match(route, new RegExp(phrase), `logs "${phrase}"`);
  }
  // exit code, stderr, sidecar size, text length are all logged on finish.
  assert.match(route, /exitCode: result\.status/);
  assert.match(route, /stderrSample: lastStderr/);
  assert.match(route, /sidecarSize: sidecarSizeNow/);
  assert.match(route, /textLength: sidecarText\.trim\(\)\.length/);
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
  assert.match(pipeline, /const ocrUnavailable = Boolean\(ocr\?\.metadata\?\._ocrRequiresReview\)/);
  assert.match(pipeline, /requiresReview = assembled\.selection\.requiresReview \|\| assembled\.validation\.requiresReview \|\| ocrUnavailable/);
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
  assert.match(intel, /if \(!outcome\.timedOut\) await loadRuns\(runId\)/, "refreshes the list + summary on terminal");
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
  assert.match(panel, /Retry \/ Force Reprocess/);

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

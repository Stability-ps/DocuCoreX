import type { ExtractionDebug, ExtractionPipelineResult, ExtractionResult, ExtractionStageDiag, ParserMethod, PdfAnalysis } from "@/lib/pdf/types";
import { analyzeExtraction } from "@/lib/pdf/analyzePdf";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { extractWithPdfplumber } from "@/lib/pdf/extractWithPdfplumber";
import { extractWithOcr } from "@/lib/pdf/extractWithOcr";
import { mergeExtractionResults } from "@/lib/pdf/mergeExtractionResults";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";
import { getCachedExtraction, setCachedExtraction } from "@/lib/pdf/extractionCache";
import type { ProcessingStep } from "@/lib/pdf/processingSteps";
import { pdfLog } from "@/lib/pdf/log";

// Time budgets per parser (Req 2). pdfplumber and OCR enforce their own budget
// internally via AbortController (PDFPLUMBER_TIMEOUT_MS / OCR_FETCH_TIMEOUT_MS);
// PDF.js runs in-process with no native timeout, so the pipeline races it.
const PDFJS_BUDGET_MS = 10_000;

// Fast-routing thresholds (Req 1).
const DIGITAL_TEXT_LAYER_MIN_CHARS = 500; // > this ⇒ trust the text layer, skip OCR
const SCANNED_TEXT_LAYER_MAX_CHARS = 20; // <= this + kind==="scanned" ⇒ go straight to OCR

export type ExtractionPipelineOptions = {
  // Cache identity — when both are present the result is reused for the same
  // document+bytes unless `force` is set (Force reprocess).
  documentId?: string | null;
  fileHash?: string | null;
  force?: boolean;
  // Progress hook — the pipeline reports "detecting" then "ocr"; the caller
  // reports the later "parsing"/"reconciling" steps around the worker call.
  onStage?: (step: ProcessingStep) => void;
};

// Race an in-process promise against a wall-clock budget. On timeout the pipeline
// proceeds with `onTimeout()` (an empty result) so a slow/hung PDF.js parse never
// blocks pdfplumber/OCR; the underlying promise is abandoned, not awaited.
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      pdfLog("budget.exceeded", { label, ms });
      resolve(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyPdfjsResult(): ExtractionResult {
  return { parser: "pdfjs", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [`PDF.js exceeded ${PDFJS_BUDGET_MS}ms budget`] };
}

// Build a per-stage diagnostic. `result === null` means the stage was skipped
// (not configured); otherwise it ran — `ok` reflects whether it produced usable
// text/transactions, and any warning becomes the failureReason.
function stageDiag(stage: ExtractionStageDiag["stage"], result: ExtractionResult | null, ms: number, skippedReason?: string): ExtractionStageDiag {
  if (!result) {
    return { stage, attempted: false, ok: false, ms, pages: 0, chars: 0, transactions: 0, skippedReason: skippedReason ?? null };
  }
  const chars = result.combinedText.trim().length;
  const ok = chars > 0 || result.transactions.length > 0;
  const failure = result.warnings.find((w) => /fail|unreachable|timed out|HTTP \d|not configured|no readable/i.test(w)) ?? null;
  return { stage, attempted: true, ok, ms, pages: result.pageCount, chars, transactions: result.transactions.length, failureReason: ok ? null : failure };
}

// Fresh Uint8Array backed by a NEW ArrayBuffer. A consumer that detaches or
// transfers its buffer (PDF.js does) can never affect the original or siblings.
function copyBuffer(src: Uint8Array): Uint8Array {
  const copy = new Uint8Array(src.byteLength);
  copy.set(src);
  return copy;
}

function assemble(analysis: PdfAnalysis, inputs: { pdfjs?: ExtractionResult; pdfplumber?: ExtractionResult | null; ocr?: ExtractionResult | null }) {
  const { selection, merged } = mergeExtractionResults(analysis, {
    pdfjs: inputs.pdfjs,
    pdfplumber: inputs.pdfplumber ?? undefined,
    ocr: inputs.ocr ?? undefined,
  });
  const validation = validateBankStatement(merged);
  return { selection, merged, validation };
}

// Fault-tolerant multi-parser pipeline. Every extractor runs independently and a
// failure in one never prevents the others:
//   PDF.js (text-only, no canvas) → pdfplumber → OCR → merge → validate.
// pdfplumber ALWAYS runs (even if PDF.js failed / returned no text), so a digital
// PDF that PDF.js cannot read is still parsed. The pipeline only "fails" after all
// available extractors have been attempted, and returns per-stage diagnostics.
export async function runExtractionPipeline(buffer: Uint8Array, fileName = "statement.pdf", options: ExtractionPipelineOptions = {}): Promise<ExtractionPipelineResult> {
  const pipelineStart = Date.now();
  const { documentId = null, fileHash = null, force = false, onStage } = options;

  // Reuse a prior extraction for the identical document+bytes (Req 3): never OCR
  // or re-parse the same file twice. Force reprocess bypasses the cache.
  if (!force) {
    const cached = getCachedExtraction(documentId, fileHash);
    if (cached) {
      pdfLog("pipeline_cache_reused", { documentId, parserMethod: cached.parserMethod, ocrUsed: cached.ocrUsed });
      return { ...cached, cached: true };
    }
  }

  // Keep the ORIGINAL buffer immutable and hand every extractor its own fresh copy.
  // PDF.js detaches/transfers the ArrayBuffer it processes, which would otherwise
  // leave pdfplumber / OCR with a detached buffer ("...slice on a detached
  // ArrayBuffer"). copyBuffer guarantees each stage gets a valid full PDF.
  const original = buffer;
  const originalBytes = original.byteLength;
  pdfLog("start", { fileName, bytes: originalBytes, original_bytes: originalBytes });
  const stages: ExtractionStageDiag[] = [];

  // Step 1 — detect the PDF type (PDF.js text extraction, time-boxed to 10s).
  onStage?.("detecting");
  const t1 = Date.now();
  const pdfjsBuf = copyBuffer(original);
  const pdfjsBytes = pdfjsBuf.byteLength;
  const pdfjs = await withTimeout(extractWithPdfjs(pdfjsBuf), PDFJS_BUDGET_MS, emptyPdfjsResult, "pdfjs");
  stages.push(stageDiag("pdfjs", pdfjs, Date.now() - t1));
  const analysis = analyzeExtraction(pdfjs);
  const pdfjsChars = pdfjs.combinedText.trim().length;
  // Fast routing (Req 1): a substantial digital text layer (>500 chars) means the
  // PDF is not scanned — skip OCR entirely. A near-empty, clearly-scanned PDF
  // (<=20 chars) means native parsing is pointless — skip pdfplumber and go
  // straight to OCR.
  const skipOcrFastPath = pdfjsChars > DIGITAL_TEXT_LAYER_MIN_CHARS;
  const scannedFastPath = pdfjsChars <= SCANNED_TEXT_LAYER_MAX_CHARS && analysis.kind === "scanned";
  pdfLog("route.analysis", {
    pageCount: analysis.pageCount,
    totalTextLength: analysis.totalTextLength,
    averageTextPerPage: analysis.averageTextPerPage,
    kind: analysis.kind,
    isDigitalPdf: analysis.isDigitalPdf,
    needsOcr: analysis.needsOcr,
    confidence: analysis.confidence,
    pdfjsChars,
    skipOcrFastPath,
    scannedFastPath,
  });

  // Stage 2 — pdfplumber. Attempted for everything EXCEPT the clearly-scanned fast
  // path (no text layer, so native parsing cannot help — route directly to OCR).
  // Otherwise it always runs, independent of PDF.js's result, so a PDF.js failure
  // can never skip it. Returns null only when PDF_PLUMBER_URL is not configured.
  let pdfplumber: ExtractionResult | null = null;
  let pdfplumberBytes = 0;
  if (scannedFastPath) {
    pdfLog("route.skip_pdfplumber", { reason: "scanned / no text layer", pdfjsChars });
    stages.push({ stage: "pdfplumber", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: "scanned / no text layer — routed directly to OCR" });
  } else {
    const t2 = Date.now();
    const pdfplumberBuf = copyBuffer(original);
    pdfplumberBytes = pdfplumberBuf.byteLength;
    pdfplumber = await extractWithPdfplumber(pdfplumberBuf, fileName);
    stages.push(stageDiag("pdfplumber", pdfplumber, Date.now() - t2, pdfplumber === null ? "PDF_PLUMBER_URL not configured" : undefined));
  }

  // Decide whether OCR is needed: the scanned fast path forces it; a strong digital
  // text layer (>500 chars) skips it; otherwise OCR runs when analysis flagged it
  // OR neither native extractor produced usable text/transactions.
  const nativeChars = Math.max(pdfjsChars, pdfplumber?.combinedText.trim().length ?? 0);
  const nativeTransactions = Math.max(pdfjs.transactions.length, pdfplumber?.transactions.length ?? 0);
  const needsOcr = scannedFastPath || (!skipOcrFastPath && (analysis.needsOcr || nativeTransactions === 0 || nativeChars < 20));

  // Stage 3 — OCR fallback. Returns null only when CONVERSION_WORKER_URL is unset.
  let ocr: ExtractionResult | null = null;
  let ocrAttempted = false;
  let ocrBytes = 0;
  if (needsOcr) {
    if (scannedFastPath) pdfLog("route.force_ocr", { pdfjsTextLength: pdfjsChars, reason: "scanned PDF — routed directly to OCR (pdfplumber skipped)" });
    else if (pdfjsChars < 5) pdfLog("route.force_ocr", { pdfjsTextLength: pdfjsChars, reason: "PDF.js returned almost no text" });
    onStage?.("ocr");
    ocrAttempted = true;
    const t3 = Date.now();
    const ocrBuf = copyBuffer(original);
    ocrBytes = ocrBuf.byteLength;
    ocr = await extractWithOcr(ocrBuf, fileName);
    stages.push(stageDiag("ocr", ocr, Date.now() - t3, ocr === null ? "CONVERSION_WORKER_URL not configured" : undefined));

    // Fallback (Req 6): the scanned fast path skipped pdfplumber. If OCR produced
    // nothing usable, the PDF may have been mis-classified — run the native parser
    // we skipped so the full pipeline is never bypassed on a bad guess.
    const ocrEmpty = !ocr || (ocr.combinedText.trim().length === 0 && ocr.transactions.length === 0);
    if (scannedFastPath && ocrEmpty && process.env.PDF_PLUMBER_URL) {
      pdfLog("route.fallback_pdfplumber", { reason: "scanned fast path OCR empty — running skipped native parser" });
      const t2b = Date.now();
      const pdfplumberBuf = copyBuffer(original);
      pdfplumberBytes = pdfplumberBuf.byteLength;
      pdfplumber = await extractWithPdfplumber(pdfplumberBuf, fileName);
      const diag = stageDiag("pdfplumber", pdfplumber, Date.now() - t2b, pdfplumber === null ? "PDF_PLUMBER_URL not configured" : undefined);
      const idx = stages.findIndex((s) => s.stage === "pdfplumber");
      if (idx >= 0) stages[idx] = diag;
      else stages.push(diag);
    }
  } else {
    stages.push({ stage: "ocr", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: skipOcrFastPath ? "digital text layer (>500 chars) — OCR skipped" : "native extraction sufficient" });
  }

  // Merge + validate.
  let assembled = assemble(analysis, { pdfjs, pdfplumber, ocr });

  // Reconciliation retry: native parse did not reconcile and OCR hasn't run → OCR.
  if (assembled.validation.requiresReview && !ocrAttempted) {
    pdfLog("route.ocr_retry", { reason: "reconciliation failed on native parse", difference: assembled.validation.difference });
    ocrAttempted = true;
    const tR = Date.now();
    const ocrBuf = copyBuffer(original);
    ocrBytes = ocrBuf.byteLength;
    ocr = await extractWithOcr(ocrBuf, fileName);
    stages.push(stageDiag("ocr", ocr, Date.now() - tR, ocr === null ? "CONVERSION_WORKER_URL not configured" : undefined));
    if (ocr && (ocr.combinedText.length > 0 || ocr.transactions.length > 0)) {
      const retry = assemble(analysis, { pdfjs, pdfplumber, ocr });
      if (retry.validation.valid || retry.selection.confidence > assembled.selection.confidence) assembled = retry;
    }
  }

  // Each extractor received a valid full-size buffer (original never detached).
  pdfLog("buffers", { original_bytes: originalBytes, pdfjs_bytes: pdfjsBytes, pdfplumber_bytes: pdfplumberBytes, ocr_bytes: ocrBytes });

  const routeReason = describeRoute(analysis, stages);
  const ocrTextLength = ocr ? ocr.combinedText.trim().length : 0;
  const ocrUsed = Boolean(ocr && ocrTextLength > 0 && assembled.merged.parser !== "pdfjs");
  const ocrConfigured = !(ocrAttempted && ocr === null);

  const parserMethod: ParserMethod = assembled.selection.selectedParser;
  const warnings = [...new Set([...assembled.selection.warnings, ...assembled.merged.warnings])];
  // OCR was needed but the worker stayed unavailable (HTTP 502 after retry) or
  // timed out, and no native source recovered transactions → flag for review so
  // the failure is surfaced with parserDebug.ocr rather than a silent empty parse.
  const ocrUnavailable = Boolean(ocr?.metadata?._ocrRequiresReview) && assembled.merged.transactions.length === 0;
  const requiresReview = assembled.selection.requiresReview || assembled.validation.requiresReview || ocrUnavailable;
  if (assembled.validation.requiresReview) warnings.push("Extraction completed but reconciliation needs review.");
  if (ocrUnavailable) warnings.push("OCR service was unavailable (HTTP 502/timeout) — statement flagged for review.");

  // Extraction debug — the exact reason nothing parsed, never hidden.
  const pdfjsTextLength = pdfjs.combinedText.trim().length;
  const pdfplumberTextLength = pdfplumber ? pdfplumber.combinedText.trim().length : 0;
  const preExtractedTextLength = assembled.merged.combinedText.trim().length;
  const ocrDebug = ocr && ocr.metadata && typeof ocr.metadata._ocrDebug === "object" ? (ocr.metadata._ocrDebug as Record<string, unknown>) : null;
  const ocrReason = ocr && typeof ocr.metadata?._ocrReason === "string" ? (ocr.metadata._ocrReason as string) : null;

  let reasonNoTransactions: string | null = null;
  if (assembled.merged.transactions.length === 0) {
    const okStage = stages.find((s) => s.ok);
    if (okStage) {
      reasonNoTransactions = `Text extracted by ${okStage.stage} but no transaction rows were detected`;
    } else if (ocrAttempted && !ocrConfigured && (analysis.kind === "scanned" || analysis.kind === "weak-text")) {
      reasonNoTransactions = "OCR is required for this PDF but is not configured — set CONVERSION_WORKER_URL on the app.";
    } else if (ocrTextLength === 0 && ocrAttempted) {
      reasonNoTransactions = ocrReason || "OCR completed but no readable text was found";
    } else if (preExtractedTextLength < 20) {
      // Every extractor failed — summarise why.
      const failures = stages.filter((s) => s.attempted && !s.ok).map((s) => `${s.stage}: ${s.failureReason ?? "no text"}`);
      const skipped = stages.filter((s) => !s.attempted).map((s) => `${s.stage}: ${s.skippedReason ?? "skipped"}`);
      reasonNoTransactions = `No readable text could be extracted. ${[...failures, ...skipped].join("; ")}`.trim();
    } else {
      reasonNoTransactions = "Text was extracted but no transaction rows were detected";
    }
  }

  const debug: ExtractionDebug = {
    pdfjsTextLength,
    pdfplumberTextLength,
    ocrTextLength,
    preExtractedTextLength,
    sampleText: assembled.merged.combinedText.slice(0, 1000),
    reasonNoTransactions,
    ocr: ocrDebug ?? (ocrAttempted && !ocrConfigured ? { ocr_status: "skipped", reason: "CONVERSION_WORKER_URL not configured" } : null),
    stages,
  };

  pdfLog("route.merge", { selectedParser: assembled.selection.selectedParser, confidence: assembled.selection.confidence, extractionScores: assembled.selection.extractionScores, reasons: assembled.selection.reasons });
  pdfLog("pipeline_completed", {
    parserMethod,
    ocrUsed,
    ocrConfigured,
    requiresReview,
    reconciled: assembled.validation.valid,
    reasonNoTransactions,
    stages: stages.map((s) => ({ stage: s.stage, attempted: s.attempted, ok: s.ok, ms: s.ms, chars: s.chars, transactions: s.transactions, reason: s.failureReason ?? s.skippedReason ?? null })),
    totalMs: Date.now() - pipelineStart,
  });

  const result: ExtractionPipelineResult = {
    analysis,
    ocrUsed,
    parserMethod,
    routeReason,
    selection: assembled.selection,
    merged: assembled.merged,
    validation: assembled.validation,
    warnings: [...new Set(warnings)],
    requiresReview,
    debug,
    cached: false,
  };
  // Cache by document_id + file_hash ONLY when extraction actually succeeded, so a
  // scanned PDF that OCR'd successfully is never OCR'd again — but a failed/
  // unavailable OCR (502/timeout) is NOT cached, so a later attempt can retry
  // (Req 10).
  const extractionSucceeded = assembled.merged.combinedText.trim().length > 0 || assembled.merged.transactions.length > 0;
  if (extractionSucceeded && !ocrUnavailable) setCachedExtraction(documentId, fileHash, result);
  else pdfLog("pipeline_cache_skipped", { reason: ocrUnavailable ? "OCR unavailable — will retry" : "no usable extraction", extractionSucceeded });
  return result;
}

// Human-readable summary of which extractor won and how the others fared.
function describeRoute(analysis: PdfAnalysis, stages: ExtractionStageDiag[]): string {
  const winner = stages.filter((s) => s.ok).sort((a, b) => b.transactions - a.transactions || b.chars - a.chars)[0];
  const parts = stages.map((s) => {
    if (!s.attempted) return `${s.stage} skipped (${s.skippedReason ?? "n/a"})`;
    if (s.ok) return `${s.stage} ok (${s.chars} chars, ${s.transactions} tx)`;
    return `${s.stage} failed (${s.failureReason ?? "no text"})`;
  });
  const lead = winner ? `Best source: ${winner.stage}.` : `No extractor produced text (${analysis.kind}).`;
  return `${lead} ${parts.join("; ")}.`;
}

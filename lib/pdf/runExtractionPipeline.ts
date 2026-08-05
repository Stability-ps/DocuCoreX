import type { ExtractionDebug, ExtractionPipelineResult, ExtractionResult, ExtractionStageDiag, OcrEngineId, ParserMethod, PdfAnalysis } from "@/lib/pdf/types";
import { analyzeExtraction } from "@/lib/pdf/analyzePdf";
import { decideOcrNeed } from "@/lib/pdf/ocrDecision";
import { selectExtractionStrategy } from "@/lib/pdf/extractionStrategy";
import { decideMistralOcr } from "@/lib/pdf/mistralDecision";
import { decideAzureExtraction } from "@/lib/pdf/azureDecision";
import { extractWithAzureDocumentIntelligence, isAzureConfigured } from "@/lib/pdf/extractWithAzureDocumentIntelligence";
import { acceptExtraction, type AcceptanceResult, type ExtractionExpectation } from "@/lib/pdf/acceptExtraction";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { extractWithPdfplumber } from "@/lib/pdf/extractWithPdfplumber";
import { extractWithOcr } from "@/lib/pdf/extractWithOcr";
import { extractWithMistralOcr, isMistralConfigured } from "@/lib/pdf/extractWithMistralOcr";
import { getCachedExtraction, setCachedExtraction } from "@/lib/pdf/extractionCache";
import type { ProcessingStep } from "@/lib/pdf/processingSteps";
import { pdfLog } from "@/lib/pdf/log";

// Time budgets per parser (Req 2). pdfplumber and OCR enforce their own budget
// internally via AbortController (PDFPLUMBER_TIMEOUT_MS / OCR_FETCH_TIMEOUT_MS);
// PDF.js runs in-process with no native timeout, so the pipeline races it.
const PDFJS_BUDGET_MS = 10_000;

export type ExtractionPipelineOptions = {
  // Cache identity — when both are present the result is reused for the same
  // document+bytes unless `force` is set (Force reprocess).
  documentId?: string | null;
  fileHash?: string | null;
  force?: boolean;
  // Enhanced OCR: always escalate to the secondary engine, even when the primary
  // extraction would otherwise be accepted.
  enhancedOcr?: boolean;
  // What the document is expected to be. "bank_statement" (the default) applies
  // completeness + reconciliation checks; "document" requires only that readable
  // content was recovered and the sources agree. Getting this wrong for a generic
  // document costs a needless escalation through BOTH OCR engines.
  expect?: ExtractionExpectation;
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

/**
 * Fault-tolerant, analysis-driven extraction pipeline.
 *
 *   1. ANALYSE   — always. PDF.js text layer → digital | weak-text | scanned.
 *   2. STRATEGY  — selectExtractionStrategy(). Native is preferred for genuine
 *                  digital PDFs; OCR cannot improve correctly embedded text.
 *   3. EXTRACT   — native always; OCR upfront only when the strategy says so.
 *   4. ACCEPT    — acceptExtraction(). The SAME gate for every strategy.
 *   5. ESCALATE  — on rejection (or Enhanced OCR), a ladder of providers, each
 *                  re-entering step 4 and stopping on the first acceptance:
 *                  Azure Document Intelligence → Mistral OCR → Tesseract.
 *
 * Every extractor runs independently and a failure in one never prevents the
 * others. The pipeline only "fails" after all available extractors have been
 * attempted, and always returns per-stage diagnostics.
 */
export async function runExtractionPipeline(buffer: Uint8Array, fileName = "statement.pdf", options: ExtractionPipelineOptions = {}): Promise<ExtractionPipelineResult> {
  const pipelineStart = Date.now();
  const { documentId = null, fileHash = null, force = false, enhancedOcr = false, expect = "bank_statement", onStage } = options;

  // Reuse a prior extraction for the identical document+bytes (Req 3): never OCR
  // or re-parse the same file twice. Force reprocess bypasses the cache.
  // An Enhanced OCR request is NOT satisfied by a standard cached result —
  // otherwise "Enhanced OCR" would silently no-op.
  if (!force) {
    const cached = getCachedExtraction(documentId, fileHash);
    // An Enhanced request is satisfied only by a result that was itself produced
    // by an Enhanced run. Checking for a specific provider broke the moment a
    // third one was added: a cached Azure run would have satisfied an Enhanced
    // request that never reached Mistral or Tesseract.
    if (cached && (!enhancedOcr || cached.enhanced)) {
      pdfLog("pipeline_cache_reused", { documentId, parserMethod: cached.parserMethod, ocrUsed: cached.ocrUsed, ocrEngine: cached.ocrEngine });
      return { ...cached, cached: true };
    }
    if (cached) pdfLog("pipeline_cache_bypassed", { documentId, reason: "enhanced OCR requested but the cached result came from a standard run" });
  }

  // Keep the ORIGINAL buffer immutable and hand every extractor its own fresh copy.
  // PDF.js detaches/transfers the ArrayBuffer it processes, which would otherwise
  // leave pdfplumber / OCR with a detached buffer ("...slice on a detached
  // ArrayBuffer"). copyBuffer guarantees each stage gets a valid full PDF.
  const original = buffer;
  const originalBytes = original.byteLength;
  pdfLog("start", { fileName, bytes: originalBytes, original_bytes: originalBytes, enhancedOcr });
  const stages: ExtractionStageDiag[] = [];

  // ---- Step 1: ANALYSE (mandatory for every document) ------------------------
  onStage?.("detecting");
  const t1 = Date.now();
  const pdfjsBuf = copyBuffer(original);
  const pdfjsBytes = pdfjsBuf.byteLength;
  const pdfjs = await withTimeout(extractWithPdfjs(pdfjsBuf), PDFJS_BUDGET_MS, emptyPdfjsResult, "pdfjs");
  stages.push(stageDiag("pdfjs", pdfjs, Date.now() - t1));
  const analysis = analyzeExtraction(pdfjs);
  const pdfjsChars = pdfjs.combinedText.trim().length;

  // ---- Step 2: STRATEGY ------------------------------------------------------
  const plan = selectExtractionStrategy(analysis);
  pdfLog("route.strategy", {
    strategy: plan.strategy,
    reason: plan.reason,
    ocrUpfront: plan.ocrUpfront,
    kind: analysis.kind,
    pageCount: analysis.pageCount,
    averageTextPerPage: analysis.averageTextPerPage,
    confidence: analysis.confidence,
    pdfjsChars,
  });

  // ---- Step 3: EXTRACT (native) ---------------------------------------------
  // pdfplumber ALWAYS runs, independent of PDF.js: it is cheap (~150ms) even for
  // scanned PDFs (returns empty), and it means a PDF.js runtime hiccup can never
  // force OCR on a genuinely digital PDF that pdfplumber can still read.
  let pdfplumber: ExtractionResult | null = null;
  let pdfplumberBytes = 0;
  {
    const t2 = Date.now();
    const pdfplumberBuf = copyBuffer(original);
    pdfplumberBytes = pdfplumberBuf.byteLength;
    pdfplumber = await extractWithPdfplumber(pdfplumberBuf, fileName);
    stages.push(stageDiag("pdfplumber", pdfplumber, Date.now() - t2, pdfplumber === null ? "PDF_PLUMBER_URL not configured" : undefined));
  }

  // ---- Step 3b: EXTRACT (primary OCR, only when the strategy calls for it) ----
  const pdfplumberChars = pdfplumber?.combinedText.trim().length ?? 0;
  const nativeTransactions = Math.max(pdfjs.transactions.length, pdfplumber?.transactions.length ?? 0);
  const coverage = analysis.pages.length ? analysis.pages.filter((p) => p.hasText).length / analysis.pages.length : 0;

  let ocr: ExtractionResult | null = null;
  let ocrAttempted = false;
  let ocrBytes = 0;

  // Returns the result rather than mutating `ocr` in place: an assignment made
  // inside a closure is invisible to TypeScript's control-flow analysis, which
  // would then narrow `ocr` to `null` for the rest of the function.
  const runPrimaryOcr = async (why: string): Promise<ExtractionResult | null> => {
    pdfLog("route.force_ocr", { pdfjsTextLength: pdfjsChars, pdfplumberTextLength: pdfplumberChars, reason: why });
    onStage?.("ocr");
    const t = Date.now();
    const ocrBuf = copyBuffer(original);
    ocrBytes = ocrBuf.byteLength;
    const result = await extractWithOcr(ocrBuf, fileName);
    stages.push(stageDiag("ocr", result, Date.now() - t, result === null ? "CONVERSION_WORKER_URL not configured" : undefined));
    return result;
  };

  if (plan.ocrUpfront) {
    // Even when the strategy allows OCR, the evidence-based guard decides whether
    // it is actually worth running given what native extraction recovered.
    const ocrDecision = decideOcrNeed({
      kind: analysis.kind,
      pdfjsChars,
      pdfplumberChars,
      nativeTransactions,
      coverage,
      pageCount: analysis.pageCount,
      confidence: analysis.confidence,
      skipOcrFastPath: false,
    });
    pdfLog("route.ocr_decision", { strategy: plan.strategy, needsOcr: ocrDecision.needsOcr, reason: ocrDecision.reason, pdfjsChars, pdfplumberChars, nativeChars: Math.max(pdfjsChars, pdfplumberChars), nativeTransactions, coverage: Math.round(coverage * 100) / 100, kind: analysis.kind });
    // Tesseract is NO LONGER run upfront. The escalation ladder (step 5) owns
    // engine ordering — Azure, then Mistral, then Tesseract — so a scanned
    // document reaches the strongest structured extractor first instead of
    // spending its first attempt on the weakest.
    if (ocrDecision.needsOcr) {
      stages.push({ stage: "ocr", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: `deferred to the escalation ladder — ${ocrDecision.reason}` });
    } else {
      stages.push({ stage: "ocr", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: ocrDecision.reason });
    }
  } else {
    pdfLog("route.ocr_decision", { strategy: plan.strategy, needsOcr: false, reason: plan.reason });
    stages.push({ stage: "ocr", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: `strategy "${plan.strategy}" — ${plan.reason}` });
  }

  // ---- Step 4: ACCEPT --------------------------------------------------------
  let assembled: AcceptanceResult = acceptExtraction(analysis, { pdfjs, pdfplumber: pdfplumber ?? undefined, ocr: ocr ?? undefined }, { expect });
  pdfLog("route.accept", { expect, verdict: assembled.verdict, selectedParser: assembled.selection.selectedParser, confidence: assembled.selection.confidence, rejectionReasons: assembled.rejectionReasons });

  // ---- Step 5: ESCALATE ------------------------------------------------------
  // Ladder: Azure Document Intelligence → Mistral OCR → Tesseract. Each rung
  // re-enters the SAME acceptance gate and stops the moment a result passes, so
  // a healthy digital PDF reaches none of them.
  //
  // Azure runs first because prebuilt-layout returns real table structure —
  // which is what a statement's transaction rows are — while the OCR engines
  // return text that has to be re-derived by regex. Tesseract is last: it is
  // free, but it is also the weakest at preserving column structure.
  let mistral: ExtractionResult | null = null;
  let mistralAttempted = false;
  let azure: ExtractionResult | null = null;
  let azureAttempted = false;

  const candidatesSoFar = () => ({ pdfjs, pdfplumber: pdfplumber ?? undefined, ocr: ocr ?? undefined, mistral: mistral ?? undefined, azure: azure ?? undefined });
  // Adopt a re-accepted candidate when it passes the gate or scores higher.
  // Either way keep its comparison/verdict so the head-to-head is never lost.
  const adopt = (candidate: AcceptanceResult, label: string) => {
    const better = (candidate.accepted && !assembled.accepted) || candidate.selection.confidence > assembled.selection.confidence;
    pdfLog(`route.accept_after_${label}`, {
      verdict: candidate.verdict,
      confidence: candidate.selection.confidence,
      previousConfidence: assembled.selection.confidence,
      adopted: better,
      comparison: candidate.ocrEngineComparison,
    });
    assembled = better
      ? candidate
      : { ...assembled, ocrEngineComparison: candidate.ocrEngineComparison, selection: candidate.selection, rejectionReasons: candidate.rejectionReasons, verdict: candidate.verdict, accepted: candidate.verdict === "validated" };
  };

  if (!assembled.accepted || enhancedOcr) {
    // 5a. Azure Document Intelligence — the structured-extraction escalation.
    const nativeChars = Math.max(pdfjsChars, pdfplumberChars);
    const azureDecision = decideAzureExtraction({
      configured: isAzureConfigured(),
      enhanced: enhancedOcr,
      strategy: plan.strategy,
      expect,
      accepted: assembled.accepted,
      nativeChars,
      selectionConfidence: assembled.selection.confidence,
      transactionCount: assembled.merged.transactions.length,
      hasOpeningBalance: assembled.merged.metadata.openingBalance != null,
      hasClosingBalance: assembled.merged.metadata.closingBalance != null,
      validationRequiresReview: assembled.validation.requiresReview,
      alreadyAttempted: azureAttempted,
    });
    pdfLog("route.azure_decision", { needed: azureDecision.needed, reason: azureDecision.reason, strategy: plan.strategy, expect });

    if (azureDecision.needed) {
      onStage?.("ocr");
      azureAttempted = true;
      const t = Date.now();
      azure = await extractWithAzureDocumentIntelligence(copyBuffer(original), fileName);
      stages.push(stageDiag("azure_di", azure, Date.now() - t, azure === null ? "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/KEY not configured" : undefined));
      if (azure) adopt(acceptExtraction(analysis, candidatesSoFar(), { expect }), "azure");
    }

    // 5b. Mistral OCR — only if Azure did not satisfy the gate.
    const mistralDecision =
      assembled.accepted && !enhancedOcr
        ? { needed: false, reason: "a previous provider satisfied the acceptance gate" }
        : decideMistralOcr({
            configured: isMistralConfigured(),
            enhanced: enhancedOcr,
            strategy: plan.strategy,
            expect,
            // The PRIOR escalation provider. Under the new ladder that is Azure,
            // not Tesseract — Tesseract has not run yet at this point. Mistral's
            // "the previous engine did badly" conditions must judge whichever
            // provider actually ran before it, or they could never fire.
            ocrAttempted: azureAttempted || ocrAttempted,
            ocrChars: (azure ?? ocr) ? (azure ?? ocr)!.combinedText.trim().length : 0,
            ocrConfidence: (azure ?? ocr)?.confidence ?? null,
            selectionConfidence: assembled.selection.confidence,
            transactionCount: assembled.merged.transactions.length,
            hasOpeningBalance: assembled.merged.metadata.openingBalance != null,
            hasClosingBalance: assembled.merged.metadata.closingBalance != null,
            validationRequiresReview: assembled.validation.requiresReview,
          });
    pdfLog("route.mistral_decision", { needed: mistralDecision.needed, reason: mistralDecision.reason, strategy: plan.strategy, expect });

    if (mistralDecision.needed) {
      onStage?.("ocr");
      mistralAttempted = true;
      const t = Date.now();
      mistral = await extractWithMistralOcr(copyBuffer(original), fileName);
      stages.push(stageDiag("mistral_ocr", mistral, Date.now() - t, mistral === null ? "MISTRAL_API_KEY not configured" : undefined));
      // Re-enter the SAME acceptance gate with the enlarged candidate set. When
      // providers disagree materially, acceptExtraction has already recorded it
      // and forced review — the conflict is surfaced, not resolved silently.
      if (mistral) adopt(acceptExtraction(analysis, candidatesSoFar(), { expect }), "mistral");
    }

    // 5c. Tesseract — the free last resort, only if nothing above passed and the
    //     strategy never already ran it.
    if (!ocrAttempted && (!assembled.accepted || enhancedOcr)) {
      ocrAttempted = true;
      ocr = await runPrimaryOcr(enhancedOcr ? "Enhanced OCR requested" : `acceptance still rejected: ${assembled.rejectionReasons[0] ?? "unknown"}`);
      if (ocr) adopt(acceptExtraction(analysis, candidatesSoFar(), { expect }), "tesseract");
    }
  }

  // Each extractor received a valid full-size buffer (original never detached).
  pdfLog("buffers", { original_bytes: originalBytes, pdfjs_bytes: pdfjsBytes, pdfplumber_bytes: pdfplumberBytes, ocr_bytes: ocrBytes });

  const routeReason = describeRoute(analysis, plan.strategy, plan.reason, stages);
  const ocrText = ocr;
  const ocrTextLength = ocrText ? ocrText.combinedText.trim().length : 0;
  const mistralTextLength = mistral ? mistral.combinedText.trim().length : 0;
  const azureTextLength = azure ? azure.combinedText.trim().length : 0;
  const ocrUsed = assembled.ocrEngine != null;
  const ocrConfigured = !(ocrAttempted && ocr === null);

  const parserMethod: ParserMethod = assembled.selection.selectedParser;
  const warnings = [...new Set([...assembled.selection.warnings, ...assembled.merged.warnings])];
  // OCR was needed but the worker stayed unavailable (HTTP 502 after retry) or
  // timed out, and no native source recovered transactions → flag for review so
  // the failure is surfaced with parserDebug.ocr rather than a silent empty parse.
  const ocrUnavailable = Boolean(ocrText?.metadata?._ocrRequiresReview) && assembled.merged.transactions.length === 0;
  const requiresReview = !assembled.accepted || ocrUnavailable;
  if (assembled.validation.requiresReview) warnings.push("Extraction completed but reconciliation needs review.");
  if (ocrUnavailable) warnings.push("OCR service was unavailable (HTTP 502/timeout) — statement flagged for review.");

  // Extraction debug — the exact reason nothing parsed, never hidden.
  const pdfjsTextLength = pdfjs.combinedText.trim().length;
  const pdfplumberTextLength = pdfplumber ? pdfplumber.combinedText.trim().length : 0;
  const preExtractedTextLength = assembled.merged.combinedText.trim().length;
  const ocrDebug = ocrText && ocrText.metadata && typeof ocrText.metadata._ocrDebug === "object" ? (ocrText.metadata._ocrDebug as Record<string, unknown>) : null;
  const ocrReason = ocrText && typeof ocrText.metadata?._ocrReason === "string" ? (ocrText.metadata._ocrReason as string) : null;
  const mistralDebug = mistral && typeof mistral.metadata?._mistralDebug === "object" ? (mistral.metadata._mistralDebug as Record<string, unknown>) : null;
  const azureDebug = azure && typeof azure.metadata?._azureDebug === "object" ? (azure.metadata._azureDebug as Record<string, unknown>) : null;

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
    mistralTextLength,
    azureTextLength,
    preExtractedTextLength,
    // Never carry document text: `sampleText` is intentionally blank so it cannot
    // leak into logs (accounting failure logs the full parserDebug) or the DB.
    // Content-free length diagnostics above are retained.
    sampleText: "",
    reasonNoTransactions,
    ocr: ocrDebug ?? (ocrAttempted && !ocrConfigured ? { ocr_status: "skipped", reason: "CONVERSION_WORKER_URL not configured" } : null),
    mistral: mistralDebug ?? (mistralAttempted && mistral === null ? { status: "skipped", reason: "MISTRAL_API_KEY not configured" } : null),
    azure: azureDebug ?? (azureAttempted && azure === null ? { status: "skipped", reason: "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT/KEY not configured" } : null),
    strategy: plan.strategy,
    ocrEngine: assembled.ocrEngine,
    stages,
  };

  pdfLog("route.merge", { selectedParser: assembled.selection.selectedParser, confidence: assembled.selection.confidence, extractionScores: assembled.selection.extractionScores, reasons: assembled.selection.reasons });
  pdfLog("pipeline_completed", {
    strategy: plan.strategy,
    parserMethod,
    verdict: assembled.verdict,
    ocrUsed,
    ocrEngine: assembled.ocrEngine,
    ocrEngineComparison: assembled.ocrEngineComparison,
    ocrConfigured,
    requiresReview,
    reconciled: assembled.validation.valid,
    reasonNoTransactions,
    disagreements: assembled.selection.disagreements.map((d) => d.field),
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
    strategy: plan.strategy,
    ocrEngine: assembled.ocrEngine,
    ocrEngineComparison: assembled.ocrEngineComparison,
    enhanced: enhancedOcr,
    verdict: assembled.verdict,
    accepted: assembled.accepted,
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

// Human-readable summary of the strategy taken, which extractor won and how the
// others fared.
function describeRoute(analysis: PdfAnalysis, strategy: string, strategyReason: string, stages: ExtractionStageDiag[]): string {
  const winner = stages.filter((s) => s.ok).sort((a, b) => b.transactions - a.transactions || b.chars - a.chars)[0];
  const parts = stages.map((s) => {
    if (!s.attempted) return `${s.stage} skipped (${s.skippedReason ?? "n/a"})`;
    if (s.ok) return `${s.stage} ok (${s.chars} chars, ${s.transactions} tx)`;
    return `${s.stage} failed (${s.failureReason ?? "no text"})`;
  });
  const lead = winner ? `Strategy ${strategy} (${strategyReason}). Best source: ${winner.stage}.` : `Strategy ${strategy}. No extractor produced text (${analysis.kind}).`;
  return `${lead} ${parts.join("; ")}.`;
}

export type { OcrEngineId };

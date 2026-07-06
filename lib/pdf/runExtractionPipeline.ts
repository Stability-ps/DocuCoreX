import type { ExtractionDebug, ExtractionPipelineResult, ExtractionResult, ExtractionStageDiag, ParserMethod, PdfAnalysis } from "@/lib/pdf/types";
import { analyzeExtraction } from "@/lib/pdf/analyzePdf";
import { extractWithPdfjs } from "@/lib/pdf/extractWithPdfjs";
import { extractWithPdfplumber } from "@/lib/pdf/extractWithPdfplumber";
import { extractWithOcr } from "@/lib/pdf/extractWithOcr";
import { mergeExtractionResults } from "@/lib/pdf/mergeExtractionResults";
import { validateBankStatement } from "@/lib/accounting/validateBankStatement";
import { pdfLog } from "@/lib/pdf/log";

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
export async function runExtractionPipeline(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionPipelineResult> {
  const pipelineStart = Date.now();
  pdfLog("start", { fileName, bytes: buffer.byteLength });
  const stages: ExtractionStageDiag[] = [];

  // Stage 1 — PDF.js text extraction (never throws; empty result on failure).
  const t1 = Date.now();
  const pdfjs = await extractWithPdfjs(buffer);
  stages.push(stageDiag("pdfjs", pdfjs, Date.now() - t1));
  const analysis = analyzeExtraction(pdfjs);
  pdfLog("route.analysis", {
    pageCount: analysis.pageCount,
    totalTextLength: analysis.totalTextLength,
    averageTextPerPage: analysis.averageTextPerPage,
    kind: analysis.kind,
    isDigitalPdf: analysis.isDigitalPdf,
    needsOcr: analysis.needsOcr,
    confidence: analysis.confidence,
  });

  // Stage 2 — pdfplumber. ALWAYS attempted (independent of PDF.js's result /
  // classification), so a PDF.js failure can never skip it. Returns null only when
  // PDF_PLUMBER_URL is not configured.
  const t2 = Date.now();
  const pdfplumber = await extractWithPdfplumber(buffer, fileName);
  stages.push(stageDiag("pdfplumber", pdfplumber, Date.now() - t2, pdfplumber === null ? "PDF_PLUMBER_URL not configured" : undefined));

  // Decide whether OCR is needed: analysis flagged it, OR neither native extractor
  // produced usable text/transactions.
  const nativeChars = Math.max(pdfjs.combinedText.trim().length, pdfplumber?.combinedText.trim().length ?? 0);
  const nativeTransactions = Math.max(pdfjs.transactions.length, pdfplumber?.transactions.length ?? 0);
  const needsOcr = analysis.needsOcr || nativeTransactions === 0 || nativeChars < 20;

  // Stage 3 — OCR fallback. Returns null only when CONVERSION_WORKER_URL is unset.
  let ocr: ExtractionResult | null = null;
  let ocrAttempted = false;
  if (needsOcr) {
    if (pdfjs.combinedText.trim().length < 5) pdfLog("route.force_ocr", { pdfjsTextLength: pdfjs.combinedText.trim().length, reason: "PDF.js returned almost no text" });
    ocrAttempted = true;
    const t3 = Date.now();
    ocr = await extractWithOcr(buffer, fileName);
    stages.push(stageDiag("ocr", ocr, Date.now() - t3, ocr === null ? "CONVERSION_WORKER_URL not configured" : undefined));
  } else {
    stages.push({ stage: "ocr", attempted: false, ok: false, ms: 0, pages: 0, chars: 0, transactions: 0, skippedReason: "native extraction sufficient" });
  }

  // Merge + validate.
  let assembled = assemble(analysis, { pdfjs, pdfplumber, ocr });

  // Reconciliation retry: native parse did not reconcile and OCR hasn't run → OCR.
  if (assembled.validation.requiresReview && !ocrAttempted) {
    pdfLog("route.ocr_retry", { reason: "reconciliation failed on native parse", difference: assembled.validation.difference });
    ocrAttempted = true;
    const tR = Date.now();
    ocr = await extractWithOcr(buffer, fileName);
    stages.push(stageDiag("ocr", ocr, Date.now() - tR, ocr === null ? "CONVERSION_WORKER_URL not configured" : undefined));
    if (ocr && (ocr.combinedText.length > 0 || ocr.transactions.length > 0)) {
      const retry = assemble(analysis, { pdfjs, pdfplumber, ocr });
      if (retry.validation.valid || retry.selection.confidence > assembled.selection.confidence) assembled = retry;
    }
  }

  const routeReason = describeRoute(analysis, stages);
  const ocrTextLength = ocr ? ocr.combinedText.trim().length : 0;
  const ocrUsed = Boolean(ocr && ocrTextLength > 0 && assembled.merged.parser !== "pdfjs");
  const ocrConfigured = !(ocrAttempted && ocr === null);

  const parserMethod: ParserMethod = assembled.selection.selectedParser;
  const warnings = [...new Set([...assembled.selection.warnings, ...assembled.merged.warnings])];
  const requiresReview = assembled.selection.requiresReview || assembled.validation.requiresReview;
  if (assembled.validation.requiresReview) warnings.push("Extraction completed but reconciliation needs review.");

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

  return {
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
  };
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

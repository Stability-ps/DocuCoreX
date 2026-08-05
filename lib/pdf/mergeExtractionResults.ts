import type { ExtractionDisagreement, ExtractionResult, ExtractionScore, ParserSelection, PdfAnalysis } from "@/lib/pdf/types";
import { scoreExtraction } from "@/lib/pdf/scoreExtraction";

type ParserKey = "pdfjs" | "pdfplumber" | "ocr" | "mistral_ocr" | "azure_di";
type Inputs = { pdfjs?: ExtractionResult; pdfplumber?: ExtractionResult; ocr?: ExtractionResult; mistral?: ExtractionResult; azure?: ExtractionResult };

export const DISAGREEMENT_PENALTY_PER_WARNING = 15;
export const MAX_DISAGREEMENT_PENALTY = 30;

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

// A transaction-count gap this large (or larger) is material rather than noise.
function materialCountGap(min: number, max: number): boolean {
  return max - min > Math.max(2, min * 0.02);
}

// Prefer pdfplumber tables for transaction rows, PDF.js text for metadata, and
// OCR only when the page is scanned/weak. Disagreement on transaction count,
// totals or closing balance flags the document for review — never silently
// accept an inconsistent merge.
export function mergeExtractionResults(
  analysis: PdfAnalysis,
  inputs: Inputs,
): { selection: ParserSelection; merged: ExtractionResult } {
  const scores: ParserSelection["extractionScores"] = {};
  const available: Array<{ key: ParserKey; result: ExtractionResult; score: ExtractionScore }> = [];
  const byKey: Partial<Record<ParserKey, ExtractionResult>> = {
    pdfjs: inputs.pdfjs,
    pdfplumber: inputs.pdfplumber,
    ocr: inputs.ocr,
    mistral_ocr: inputs.mistral,
    azure_di: inputs.azure,
  };
  for (const key of ["pdfjs", "pdfplumber", "ocr", "mistral_ocr", "azure_di"] as ParserKey[]) {
    const result = byKey[key];
    if (result) {
      const score = scoreExtraction(result);
      scores[key] = score;
      available.push({ key, result, score });
    }
  }

  const reasons: string[] = [];
  const warnings: string[] = [];
  const disagreements: ExtractionDisagreement[] = [];


  // Best transaction source: prefer pdfplumber tables, then OCR (scanned), then
  // PDF.js — using the first in that order that actually captured transactions.
  // When BOTH OCR engines produced a result, the higher-scoring one is promoted
  // ahead of the other; Tesseract keeps the tie because it is the primary engine.
  // Azure sits ahead of the OCR engines: prebuilt-layout returns real table
  // structure, which is what transaction rows are, whereas the OCR engines return
  // text that has to be re-parsed by regex.
  const preferenceOrder: ParserKey[] = ["pdfplumber", "azure_di", "ocr", "mistral_ocr", "pdfjs"];
  const primaryOcr = available.find((c) => c.key === "ocr");
  const secondaryOcr = available.find((c) => c.key === "mistral_ocr");
  if (primaryOcr && secondaryOcr && secondaryOcr.score.score > primaryOcr.score.score) {
    const ocrIndex = preferenceOrder.indexOf("ocr");
    preferenceOrder.splice(preferenceOrder.indexOf("mistral_ocr"), 1);
    preferenceOrder.splice(ocrIndex, 0, "mistral_ocr");
    reasons.push(`mistral_ocr outscored tesseract (${secondaryOcr.score.score} vs ${primaryOcr.score.score})`);
  }

  const byTransactionRows = [...available].sort((a, b) => b.result.transactions.length - a.result.transactions.length || b.score.transactionRows - a.score.transactionRows || b.score.score - a.score.score);
  let transactionSource: (typeof available)[number] | null = null;
  for (const key of preferenceOrder) {
    const candidate = available.find((c) => c.key === key);
    if (candidate && (candidate.result.transactions.length > 0 || candidate.score.transactionRows > 0)) {
      transactionSource = candidate;
      break;
    }
  }
  if (!transactionSource) transactionSource = byTransactionRows[0] ?? null;

  // Best metadata source: PDF.js text preferred, else whoever has the most
  // statement metadata fields populated.
  const metadataSource =
    available.find((c) => c.key === "pdfjs" && (c.result.metadata.openingBalance != null || c.result.metadata.closingBalance != null)) ??
    [...available].sort((a, b) => Object.keys(b.result.metadata).length - Object.keys(a.result.metadata).length)[0] ??
    null;

  if (!available.length) {
    const empty: ExtractionResult = { parser: "hybrid", pageCount: analysis.pageCount, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: ["No extractor produced a result."] };
    return {
      selection: { selectedParser: "hybrid", confidence: 0, reasons: ["No extractor succeeded."], extractionScores: scores, warnings: empty.warnings, requiresReview: true, disagreements: [] },
      merged: empty,
    };
  }

  // The richest text source, used ONLY when nothing captured transactions.
  const textSource = [...available].sort((a, b) => b.score.pageCoverage - a.score.pageCoverage || b.result.combinedText.length - a.result.combinedText.length)[0];

  // ---- Coherence -------------------------------------------------------------
  // Text, pages and transactions MUST come from the same extraction.
  //
  // These used to be chosen independently: transactions from `transactionSource`
  // but text from whichever candidate had the highest page coverage, tie-broken
  // by longest string. An engine that returns verbose text but parses no rows
  // (Mistral emits markdown for every page) therefore won the text while another
  // engine won the transactions, producing a merged result whose text and rows
  // came from different parsers.
  //
  // That matters because the accounting worker does NOT receive the transaction
  // objects — buildWorkerInput sends only `merged.combinedText`, and the worker
  // re-parses it. Handing it text from a parser that extracted nothing meant the
  // worker re-derived a fraction of the rows and reconciliation failed by a large
  // margin, even though a native parser had already extracted the statement
  // correctly.
  const primary = transactionSource ?? textSource;

  // Metadata: the primary source wins, because its balances must be consistent
  // with its own transaction rows — reconciling one parser's rows against
  // another parser's closing balance is exactly how a spurious mismatch appears.
  // Other sources only FILL fields the primary did not find; they never override.
  const mergedMetadata: ExtractionResult["metadata"] = { ...(primary.result.metadata || {}) };
  const fillOrder = [metadataSource, ...available].filter((c): c is (typeof available)[number] => Boolean(c) && c!.key !== primary.key);
  for (const candidate of fillOrder) {
    for (const [key, value] of Object.entries(candidate.result.metadata || {})) {
      if (mergedMetadata[key] == null && value != null) mergedMetadata[key] = value;
    }
  }

  const merged: ExtractionResult = {
    parser: "hybrid",
    pageCount: analysis.pageCount,
    pages: primary.result.pages,
    combinedText: primary.result.combinedText,
    transactions: transactionSource ? transactionSource.result.transactions : [],
    metadata: mergedMetadata,
    warnings: [...new Set(available.flatMap((c) => c.result.warnings))],
    confidence: primary.result.confidence ?? null,
    confidenceSource: primary.result.confidenceSource ?? null,
  };
  if (primary.key !== textSource.key) {
    reasons.push(`text from ${primary.key} (kept coherent with its transactions) rather than ${textSource.key}`);
  }

  if (transactionSource) reasons.push(`transactions from ${transactionSource.key} (${transactionSource.result.transactions.length} rows, score ${transactionSource.score.score})`);
  if (metadataSource) reasons.push(`metadata from ${metadataSource.key}`);
  if (analysis.needsOcr) reasons.push(`analysis flagged ${analysis.kind} — OCR ${inputs.ocr || inputs.mistral ? "used" : "unavailable"}`);

  // Which sources may raise a disagreement.
  //
  // PDF.js is a raw text-layer probe used for analysis and routing; its
  // transaction parsing is a byproduct. When it simply finds FEWER rows than the
  // winner that is expected, not a conflict — yet each detector was charging 15
  // points for it, and four detectors took a ~98 score to 38 on a statement that
  // reconciled exactly.
  //
  // The rule is therefore ASYMMETRIC rather than a blanket exclusion. If PDF.js
  // found materially MORE rows than the winner, that is a genuine signal the
  // winner dropped data and must still be flagged. Finding fewer is noise.
  const winnerRows = transactionSource?.result.transactions.length ?? 0;
  const peers = available.filter((candidate) => {
    if (candidate.key !== "pdfjs") return true;
    const pdfjsRows = candidate.result.transactions.length;
    return materialCountGap(winnerRows, pdfjsRows) && pdfjsRows > winnerRows;
  });

  // ---- Cross-source agreement -------------------------------------------------
  // Every material disagreement is RECORDED, not resolved silently. Any entry
  // here forces review, so a conflict between engines is surfaced to a human
  // rather than hidden behind whichever source happened to score higher.
  const withTransactions = peers.filter((c) => c.result.transactions.length > 0);
  if (withTransactions.length > 1) {
    const counts = withTransactions.map((c) => c.result.transactions.length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (materialCountGap(min, max)) {
      disagreements.push({
        field: "transactionCount",
        sources: withTransactions.map((c) => c.key),
        values: counts.map(String),
        detail: `Parsers disagree on transaction count (${counts.join(" vs ")}).`,
      });
    }
  }

  for (const field of ["closingBalance", "openingBalance"] as const) {
    const withBalance = peers
      .map((c) => ({ key: c.key, value: num(c.result.metadata[field]) }))
      .filter((c): c is { key: ParserKey; value: number } => c.value != null);
    if (withBalance.length > 1 && new Set(withBalance.map((c) => c.value.toFixed(2))).size > 1) {
      disagreements.push({
        field,
        sources: withBalance.map((c) => c.key),
        values: withBalance.map((c) => c.value.toFixed(2)),
        detail: `Parsers disagree on ${field === "closingBalance" ? "closing" : "opening"} balance (${withBalance.map((c) => c.value.toFixed(2)).join(" vs ")}).`,
      });
    }
  }

  // Amount totals: compare summed debits/credits across sources that captured
  // transactions. A material gap means the engines read different figures.
  if (withTransactions.length > 1) {
    const totals = withTransactions.map((c) => ({
      key: c.key,
      total: c.result.transactions.reduce((sum, t) => sum + Math.abs(t.debit ?? 0) + Math.abs(t.credit ?? 0), 0),
    }));
    const values = totals.map((t) => t.total);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min > Math.max(0.05, min * 0.01)) {
      disagreements.push({
        field: "amountTotals",
        sources: totals.map((t) => t.key),
        values: totals.map((t) => t.total.toFixed(2)),
        detail: `Parsers disagree on total transaction value (${totals.map((t) => t.total.toFixed(2)).join(" vs ")}).`,
      });
    }
  }

  // Date coverage: a materially different first/last transaction date means one
  // engine dropped rows at an edge of the statement.
  if (withTransactions.length > 1) {
    const ranges = withTransactions
      .map((c) => {
        const dates = c.result.transactions.map((t) => t.date).filter((d): d is string => Boolean(d)).sort();
        return dates.length ? { key: c.key, range: `${dates[0]}..${dates[dates.length - 1]}` } : null;
      })
      .filter((r): r is { key: ParserKey; range: string } => r != null);
    if (ranges.length > 1 && new Set(ranges.map((r) => r.range)).size > 1) {
      disagreements.push({
        field: "dateRange",
        sources: ranges.map((r) => r.key),
        values: ranges.map((r) => r.range),
        detail: `Parsers disagree on the statement date range (${ranges.map((r) => r.range).join(" vs ")}).`,
      });
    }
  }

  warnings.push(...disagreements.map((d) => d.detail));

  // Selected parser: hybrid if we blended sources, otherwise the single winner.
  const usedMultiple = transactionSource && metadataSource && transactionSource.key !== metadataSource.key;
  const winner = transactionSource ?? textSource;
  const selectedParser: ParserSelection["selectedParser"] = usedMultiple ? "hybrid" : winner.key;

  // Confidence: winner score, reduced by disagreement.
  // Disagreement detectors are CORRELATED: a row-count difference also shows up
  // as an amount-total and a date-range difference, so four detectors usually
  // describe one root cause. Charging 15 each compounded a single discrepancy
  // into a 60-point penalty. The cap keeps the signal without letting one
  // problem be billed four times. requiresReview is unaffected — ANY
  // disagreement still forces review, so nothing is hidden by capping the score.
  const penalty = Math.min(MAX_DISAGREEMENT_PENALTY, warnings.length * DISAGREEMENT_PENALTY_PER_WARNING);
  const confidence = Math.max(0, Math.min(100, Math.round(winner.score.score - penalty)));
  const requiresReview = warnings.length > 0 || confidence < 60 || (transactionSource?.result.transactions.length ?? 0) === 0;
  if (requiresReview && !warnings.length) warnings.push("Extraction confidence is low — review before export.");

  return {
    selection: { selectedParser, confidence, reasons, extractionScores: scores, warnings, requiresReview, disagreements },
    merged,
  };
}

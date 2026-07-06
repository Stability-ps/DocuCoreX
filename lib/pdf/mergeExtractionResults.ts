import type { ExtractionResult, ExtractionScore, ParserSelection, PdfAnalysis } from "@/lib/pdf/types";
import { scoreExtraction } from "@/lib/pdf/scoreExtraction";

type ParserKey = "pdfjs" | "pdfplumber" | "ocr";
type Inputs = { pdfjs?: ExtractionResult; pdfplumber?: ExtractionResult; ocr?: ExtractionResult };

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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
  for (const key of ["pdfjs", "pdfplumber", "ocr"] as ParserKey[]) {
    const result = inputs[key];
    if (result) {
      const score = scoreExtraction(result);
      scores[key] = score;
      available.push({ key, result, score });
    }
  }

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Best transaction source: prefer pdfplumber tables, then OCR (scanned), then
  // PDF.js — using the first in that order that actually captured transactions.
  const preferenceOrder: ParserKey[] = ["pdfplumber", "ocr", "pdfjs"];
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
      selection: { selectedParser: "hybrid", confidence: 0, reasons: ["No extractor succeeded."], extractionScores: scores, warnings: empty.warnings, requiresReview: true },
      merged: empty,
    };
  }

  // Merge: transactions from the transaction source, metadata from the metadata
  // source, pages/text from the richest text source (highest coverage).
  const textSource = [...available].sort((a, b) => b.score.pageCoverage - a.score.pageCoverage || b.result.combinedText.length - a.result.combinedText.length)[0];
  const merged: ExtractionResult = {
    parser: "hybrid",
    pageCount: analysis.pageCount,
    pages: textSource.result.pages,
    combinedText: textSource.result.combinedText,
    transactions: transactionSource ? transactionSource.result.transactions : [],
    metadata: { ...(textSource.result.metadata || {}), ...(metadataSource?.result.metadata || {}) },
    warnings: [...new Set(available.flatMap((c) => c.result.warnings))],
  };

  if (transactionSource) reasons.push(`transactions from ${transactionSource.key} (${transactionSource.result.transactions.length} rows, score ${transactionSource.score.score})`);
  if (metadataSource) reasons.push(`metadata from ${metadataSource.key}`);
  if (analysis.needsOcr) reasons.push(`analysis flagged ${analysis.kind} — OCR ${inputs.ocr ? "used" : "unavailable"}`);

  // Cross-parser agreement: transaction counts, totals and closing balance.
  const counts = available.map((c) => c.result.transactions.length).filter((n) => n > 0);
  if (counts.length > 1) {
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (max - min > Math.max(2, min * 0.02)) {
      warnings.push(`Parsers disagree on transaction count (${counts.join(" vs ")}).`);
    }
  }
  const closings = available.map((c) => num(c.result.metadata.closingBalance)).filter((n): n is number => n != null);
  if (new Set(closings.map((v) => v.toFixed(2))).size > 1) {
    warnings.push(`Parsers disagree on closing balance (${closings.map((v) => v.toFixed(2)).join(" vs ")}).`);
  }

  // Selected parser: hybrid if we blended sources, otherwise the single winner.
  const usedMultiple = transactionSource && metadataSource && transactionSource.key !== metadataSource.key;
  const winner = transactionSource ?? textSource;
  const selectedParser: ParserSelection["selectedParser"] = usedMultiple ? "hybrid" : winner.key;

  // Confidence: winner score, reduced by disagreement.
  const confidence = Math.max(0, Math.min(100, Math.round((winner.score.score) - warnings.length * 15)));
  const requiresReview = warnings.length > 0 || confidence < 60 || (transactionSource?.result.transactions.length ?? 0) === 0;
  if (requiresReview && !warnings.length) warnings.push("Extraction confidence is low — review before export.");

  return {
    selection: { selectedParser, confidence, reasons, extractionScores: scores, warnings, requiresReview },
    merged,
  };
}

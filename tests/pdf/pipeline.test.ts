import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { scoreExtraction } = await import("@/lib/pdf/scoreExtraction.ts");
const { analyzeExtraction } = await import("@/lib/pdf/analyzePdf.ts");
const { mergeExtractionResults } = await import("@/lib/pdf/mergeExtractionResults.ts");
const { validateBankStatement } = await import("@/lib/accounting/validateBankStatement.ts");

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

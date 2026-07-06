import type { ExtractionResult, ExtractionScore } from "@/lib/pdf/types";

// Shared detectors used by scoring and merge.
export const DATE_RE = /\b\d{1,2}[/\- ](?:\d{1,2}|[A-Za-z]{3,9})(?:[/\- ]\d{2,4})?\b/g;
export const AMOUNT_RE = /(?:R\s*)?-?\(?\d{1,3}(?:[, ]\d{3})*(?:\.\d{2})\)?(?:\s*(?:Cr|Dr))?/gi;
const OPENING_RE = /opening balance|balance brought forward/i;
const CLOSING_RE = /closing balance|balance carried forward/i;
const DEBIT_TOTAL_RE = /(?:total\s*debits?|debit\s*transactions?)/i;
const CREDIT_TOTAL_RE = /(?:total\s*credits?|credit\s*transactions?)/i;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

// A "transaction row" is a table row (or line) that carries both a date and at
// least one amount — the strongest signal that real transactions were captured.
function transactionRowCount(result: ExtractionResult): number {
  let rows = 0;
  for (const page of result.pages) {
    for (const table of page.tables) {
      for (const row of table.rows) {
        const joined = row.join(" ");
        if (DATE_RE.test(joined) && AMOUNT_RE.test(joined)) rows += 1;
        DATE_RE.lastIndex = 0;
        AMOUNT_RE.lastIndex = 0;
      }
    }
  }
  // Also count dated + amount-bearing text lines when no tables were produced.
  if (rows === 0) {
    for (const line of result.combinedText.split(/\r?\n/)) {
      if (DATE_RE.test(line) && AMOUNT_RE.test(line)) rows += 1;
      DATE_RE.lastIndex = 0;
      AMOUNT_RE.lastIndex = 0;
    }
  }
  return rows;
}

// Running-balance consistency: for extracted transactions with balances, does
// each balance equal the previous balance + credit − debit? Higher agreement =
// more trustworthy extraction.
function runningBalanceConsistent(result: ExtractionResult): boolean {
  const withBalance = result.transactions.filter((t) => typeof t.balance === "number");
  if (withBalance.length < 2) return false;
  let consistent = 0;
  let checked = 0;
  for (let i = 1; i < withBalance.length; i += 1) {
    const prev = withBalance[i - 1].balance as number;
    const current = withBalance[i].balance as number;
    const debit = withBalance[i].debit ?? 0;
    const credit = withBalance[i].credit ?? 0;
    const expected = prev + (credit ?? 0) - (debit ?? 0);
    checked += 1;
    if (Math.abs(expected - current) < 0.05) consistent += 1;
  }
  return checked > 0 && consistent / checked >= 0.8;
}

export function scoreExtraction(result: ExtractionResult): ExtractionScore {
  const text = result.combinedText || result.pages.map((p) => p.text).join("\n");
  const dates = countMatches(text, DATE_RE);
  const amounts = countMatches(text, AMOUNT_RE);
  const tableRows = result.pages.reduce((sum, p) => sum + p.tables.reduce((s, t) => s + t.rows.length, 0), 0);
  const transactionRows = transactionRowCount(result);
  const openingBalanceFound = OPENING_RE.test(text) || result.metadata.openingBalance != null;
  const closingBalanceFound = CLOSING_RE.test(text) || result.metadata.closingBalance != null;
  const debitTotalFound = DEBIT_TOTAL_RE.test(text) || result.metadata.declaredDebitTotal != null;
  const creditTotalFound = CREDIT_TOTAL_RE.test(text) || result.metadata.declaredCreditTotal != null;
  const balanceConsistent = runningBalanceConsistent(result);
  const pagesWithText = result.pages.filter((p) => (p.text || "").trim().length > 20).length;
  const pageCoverage = result.pageCount > 0 ? pagesWithText / result.pageCount : 0;

  // Weighted score (0..100). Transaction rows dominate; metadata + coverage add
  // confidence; a consistent running balance is a strong positive signal.
  const score = Math.round(
    Math.min(100, transactionRows * 2) * 0.4 +
      Math.min(100, dates) * 0.1 +
      Math.min(100, amounts / 2) * 0.1 +
      Math.min(100, tableRows) * 0.1 +
      pageCoverage * 100 * 0.1 +
      (openingBalanceFound ? 100 : 0) * 0.04 +
      (closingBalanceFound ? 100 : 0) * 0.04 +
      (debitTotalFound ? 100 : 0) * 0.03 +
      (creditTotalFound ? 100 : 0) * 0.03 +
      (balanceConsistent ? 100 : 0) * 0.06,
  );

  return {
    dates,
    amounts,
    tableRows,
    transactionRows,
    openingBalanceFound,
    closingBalanceFound,
    debitTotalFound,
    creditTotalFound,
    runningBalanceConsistent: balanceConsistent,
    pageCoverage: Math.round(pageCoverage * 100) / 100,
    score: Math.max(0, Math.min(100, score)),
  };
}

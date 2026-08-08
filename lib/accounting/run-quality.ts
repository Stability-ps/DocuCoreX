import type { AccountingRunDetail, AccountingStatementRun, AccountingTransaction } from "@/lib/accounting/types";

export type AccountingTotals = {
  credit: number;
  debit: number;
  bankCharges: number;
};

export type AccountingRunQualityIssue = {
  needsFreshExtraction: boolean;
  reason: string;
  computedDifference: number;
  storedDifference: number | null;
  outsidePeriodCount: number;
};

const LARGE_RECONCILIATION_DIFFERENCE = 1000;

export function accountingTransactionTotals(transactions: AccountingTransaction[]): AccountingTotals {
  return {
    credit: transactions.reduce((sum, transaction) => sum + (transaction.creditAmount ?? 0), 0),
    debit: transactions.reduce((sum, transaction) => sum + (transaction.debitAmount ?? 0), 0),
    bankCharges: transactions.reduce((sum, transaction) => sum + (transaction.bankCharge ? transaction.debitAmount ?? 0 : 0), 0),
  };
}

function parseDateOnly(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function outsideStatementPeriod(transaction: AccountingTransaction, run: AccountingStatementRun) {
  const date = parseDateOnly(transaction.transactionDate);
  if (date === null) return false;
  const start = parseDateOnly(run.statementPeriodStart);
  const end = parseDateOnly(run.statementPeriodEnd);
  if (start !== null && date < start) return true;
  if (end !== null && date > end) return true;
  return false;
}

export function accountingRunQuality(detail: AccountingRunDetail | null): AccountingRunQualityIssue {
  if (!detail) {
    return { needsFreshExtraction: false, reason: "", computedDifference: 0, storedDifference: null, outsidePeriodCount: 0 };
  }

  if (detail.run.status === "queued" || detail.run.status === "processing") {
    return { needsFreshExtraction: false, reason: "", computedDifference: 0, storedDifference: null, outsidePeriodCount: 0 };
  }

  const totals = accountingTransactionTotals(detail.transactions);
  const opening = detail.run.openingBalance ?? 0;
  // An UNKNOWN closing balance is not a closing balance of zero.
  //
  // Reading it as zero made the difference equal the entire opening balance —
  // on the real Standard Bank statement, -992,452.57 + 8,161,114.63 -
  // 7,172,348.61 - 0 = -3,686.55, comfortably past the R1,000 threshold. A
  // statement that reconciles exactly was therefore declared stale forever, and
  // the auto-refresh reprocessed it on a loop.
  //
  // Where the closing balance is unknown, the difference is unknowable, and an
  // unknowable difference is not evidence of staleness.
  const closing = detail.run.closingBalance;
  const closingIsKnown = closing !== null && closing !== undefined;
  const computedDifference = closingIsKnown ? opening + totals.credit - totals.debit - closing : 0;
  const storedDifference = detail.run.reconciliationDifference ?? null;
  const outsidePeriodCount = detail.transactions.filter((transaction) => outsideStatementPeriod(transaction, detail.run)).length;
  const largeDifference = closingIsKnown && Math.abs(computedDifference) > LARGE_RECONCILIATION_DIFFERENCE;

  if (outsidePeriodCount > 0) {
    return {
      needsFreshExtraction: true,
      reason: `${outsidePeriodCount} extracted transaction${outsidePeriodCount === 1 ? "" : "s"} fall outside the statement period.`,
      computedDifference,
      storedDifference,
      outsidePeriodCount,
    };
  }

  if (largeDifference) {
    return {
      needsFreshExtraction: true,
      reason: "The saved transaction totals do not match the statement reconciliation. A fresh extraction is required.",
      computedDifference,
      storedDifference,
      outsidePeriodCount,
    };
  }

  return { needsFreshExtraction: false, reason: "", computedDifference, storedDifference, outsidePeriodCount };
}

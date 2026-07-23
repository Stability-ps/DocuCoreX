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
const DIFFERENCE_DRIFT_TOLERANCE = 5;

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

  const totals = accountingTransactionTotals(detail.transactions);
  const opening = detail.run.openingBalance ?? 0;
  const closing = detail.run.closingBalance ?? 0;
  const computedDifference = opening + totals.credit - totals.debit - closing;
  const storedDifference = detail.run.reconciliationDifference ?? null;
  const outsidePeriodCount = detail.transactions.filter((transaction) => outsideStatementPeriod(transaction, detail.run)).length;
  const largeDifference = Math.abs(computedDifference) > LARGE_RECONCILIATION_DIFFERENCE;
  const storedLargeDifference = storedDifference !== null && Math.abs(storedDifference) > LARGE_RECONCILIATION_DIFFERENCE;
  const storedDrift =
    storedDifference !== null && Math.abs(Math.abs(storedDifference) - Math.abs(computedDifference)) > DIFFERENCE_DRIFT_TOLERANCE;

  if (outsidePeriodCount > 0) {
    return {
      needsFreshExtraction: true,
      reason: `${outsidePeriodCount} extracted transaction${outsidePeriodCount === 1 ? "" : "s"} fall outside the statement period.`,
      computedDifference,
      storedDifference,
      outsidePeriodCount,
    };
  }

  if (largeDifference || storedLargeDifference || storedDrift) {
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

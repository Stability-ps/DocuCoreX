import type { BankStatementCheck, BankStatementValidation, ExtractionResult } from "@/lib/pdf/types";

// Validate an extraction against a bank statement's own figures: opening/closing
// balance, transaction/credit/debit counts, debit/credit totals, the calculated
// running balance, and any declared statement totals. Never silently accepts an
// inconsistent result — any failing rule sets requiresReview.

const TOLERANCE = 0.05;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum(values: Array<number | null | undefined>): number {
  return round(values.reduce((s: number, v) => s + (v ?? 0), 0));
}

export function validateBankStatement(result: ExtractionResult): BankStatementValidation {
  const checks: BankStatementCheck[] = [];
  const txns = result.transactions;
  const meta = result.metadata;

  const totalCredits = sum(txns.map((t) => t.credit));
  const totalDebits = sum(txns.map((t) => t.debit));
  const creditCount = txns.filter((t) => (t.credit ?? 0) > 0).length;
  const debitCount = txns.filter((t) => (t.debit ?? 0) > 0).length;

  const opening = typeof meta.openingBalance === "number" ? meta.openingBalance : null;
  const closing = typeof meta.closingBalance === "number" ? meta.closingBalance : null;

  const calculatedClosing = opening != null ? round(opening + totalCredits - totalDebits) : null;
  const difference = closing != null && calculatedClosing != null ? round(calculatedClosing - closing) : null;

  const check = (rule: string, ok: boolean, extracted: string | number | null, expected: string | number | null, detail: string) => {
    checks.push({ rule, ok, extracted, expected, detail });
  };

  if (opening != null && closing != null) {
    check(
      "reconciliation",
      difference != null && Math.abs(difference) <= TOLERANCE,
      calculatedClosing,
      closing,
      `opening ${opening} + credits ${totalCredits} − debits ${totalDebits} = ${calculatedClosing}, expected closing ${closing}`,
    );
    check("closing_balance", closing != null, closing, closing, "closing balance detected");
    check("opening_balance", opening != null, opening, opening, "opening balance detected");
  }

  const expectedCount =
    typeof meta.declaredCreditCount === "number" && typeof meta.declaredDebitCount === "number"
      ? meta.declaredCreditCount + meta.declaredDebitCount
      : null;
  if (expectedCount != null) {
    check("transaction_count", txns.length === expectedCount, txns.length, expectedCount, `extracted ${txns.length} of ${expectedCount}`);
  }
  if (typeof meta.declaredCreditCount === "number") {
    check("credit_count", creditCount === meta.declaredCreditCount, creditCount, meta.declaredCreditCount, `extracted ${creditCount} of ${meta.declaredCreditCount}`);
  }
  if (typeof meta.declaredDebitCount === "number") {
    check("debit_count", debitCount === meta.declaredDebitCount, debitCount, meta.declaredDebitCount, `extracted ${debitCount} of ${meta.declaredDebitCount}`);
  }
  if (typeof meta.declaredCreditTotal === "number") {
    check("credit_total", Math.abs(totalCredits - meta.declaredCreditTotal) <= TOLERANCE, totalCredits, meta.declaredCreditTotal, `variance ${round(totalCredits - meta.declaredCreditTotal)}`);
  }
  if (typeof meta.declaredDebitTotal === "number") {
    check("debit_total", Math.abs(totalDebits - meta.declaredDebitTotal) <= TOLERANCE, totalDebits, meta.declaredDebitTotal, `variance ${round(totalDebits - meta.declaredDebitTotal)}`);
  }

  const missingTransactionCount = expectedCount != null ? Math.max(0, expectedCount - txns.length) : null;
  const valid = checks.length > 0 && checks.every((c) => c.ok);

  return {
    valid,
    requiresReview: !valid,
    checks,
    expectedClosingBalance: closing,
    calculatedClosingBalance: calculatedClosing,
    difference,
    missingTransactionCount,
  };
}

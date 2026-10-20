// Reconciliation policy (lib/accounting/reconciliation-policy.ts): exact 0 is
// reconciled, R0.01–R0.05 needs review, more fails. Decided in minor units.
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { currencyMinorUnits, reconciliationStatus, reconciliationStatusForAmount, toMinorUnits } = await import(
  "@/lib/accounting/reconciliation-policy.ts"
);
const { summarizeStatementIntegrity } = await import("@/lib/accounting/integrity.ts");
const { validateBankStatement } = await import("@/lib/accounting/validateBankStatement.ts");

test("ZAR bands: 0 reconciled, 1–5 cents needs review, 6+ cents failed, either sign", () => {
  const cases: Array<[number, string]> = [
    [0, "reconciled"], [0.01, "needs_review"], [-0.01, "needs_review"], [0.05, "needs_review"], [-0.05, "needs_review"],
    [0.06, "failed"], [-0.06, "failed"], [1, "failed"], [-12_345.67, "failed"],
  ];
  for (const [difference, expected] of cases) assert.equal(reconciliationStatusForAmount(difference), expected, String(difference));
});

test("float residue never turns a one-cent difference into reconciled, or zero into review", () => {
  // 0.1 + 0.2 − 0.3 is 5.55e-17 in floating point: still exactly 0 cents.
  assert.equal(reconciliationStatusForAmount(0.1 + 0.2 - 0.3), "reconciled");
  // A true R0.01 that float arithmetic produced as 0.009999999892897904.
  assert.equal(reconciliationStatusForAmount(0.009999999892897904), "needs_review");
  assert.equal(reconciliationStatusForAmount(0.05000000000000071), "needs_review");
  assert.equal(reconciliationStatusForAmount(0.060000000000000005), "failed");
});

test("large balances stay exact in minor units", () => {
  assert.equal(toMinorUnits(9_999_999_999.99), 999_999_999_999);
  assert.equal(toMinorUnits(-9_999_999_999.99), -999_999_999_999);
  const opening = 1_250_000_000.0;
  const credits = 3_499_999.99;
  const debits = 2_000_000.0;
  const closing = 1_251_499_999.98; // one cent short
  const difference = toMinorUnits(opening) + toMinorUnits(credits) - toMinorUnits(debits) - toMinorUnits(closing);
  assert.equal(difference, 1);
  assert.equal(reconciliationStatus(difference), "needs_review");
});

test("refunds and reversals cancel exactly", () => {
  const charge = toMinorUnits(-149.99);
  const refund = toMinorUnits(149.99);
  assert.equal(charge + refund, 0);
  assert.equal(toMinorUnits(-0.005), -toMinorUnits(0.005), "rounding is symmetric for a charge and its reversal");
});

test("minor units follow the currency, not a fixed two decimals", () => {
  assert.equal(currencyMinorUnits("ZAR"), 2);
  assert.equal(currencyMinorUnits("usd"), 2);
  assert.equal(currencyMinorUnits("JPY"), 0);
  assert.equal(currencyMinorUnits("KWD"), 3);
  assert.equal(toMinorUnits(1250, "JPY"), 1250);
  assert.equal(toMinorUnits(12.345, "KWD"), 12345);
  assert.equal(reconciliationStatusForAmount(3, "JPY"), "needs_review");
  assert.equal(reconciliationStatusForAmount(6, "JPY"), "failed");
  assert.equal(reconciliationStatusForAmount(0.004, "BHD"), "needs_review");
  assert.equal(reconciliationStatusForAmount(0.006, "BHD"), "failed");
});

test("the status function refuses a non-integer difference", () => {
  assert.throws(() => reconciliationStatus(0.5), TypeError);
});

test("statement integrity reports review for R0.03 and never says reconciled", () => {
  const integrity = summarizeStatementIntegrity({ transactions: [], reconciliationDifference: 0.03, extractionConfidence: null });
  assert.equal(integrity.reconciled, false);
  assert.equal(integrity.reconciliationStatus, "needs_review");
  assert.equal(summarizeStatementIntegrity({ transactions: [], reconciliationDifference: null, extractionConfidence: null }).reconciliationStatus, null);
});

function statement(transactions: unknown[], metadata: Record<string, unknown>) {
  return { parser: "pdfjs", pageCount: 1, pages: [], combinedText: "", transactions, metadata, warnings: [] };
}

test("bank statement validation: opening/closing and declared totals pass only at exactly 0", () => {
  const exact = validateBankStatement(statement([{ debit: 100.1, credit: null }, { debit: null, credit: 0.2 }], { openingBalance: 1000, closingBalance: 900.1 }) as never);
  assert.equal(exact.valid, true);
  assert.equal(exact.reconciliationStatus, "reconciled");

  const twoCents = validateBankStatement(statement([{ debit: 100, credit: null }], { openingBalance: 1000, closingBalance: 899.98 }) as never);
  assert.equal(twoCents.valid, false);
  assert.equal(twoCents.requiresReview, true);
  assert.equal(twoCents.reconciliationStatus, "needs_review");

  const failed = validateBankStatement(statement([{ debit: 100, credit: null }], { openingBalance: 1000, closingBalance: 899 }) as never);
  assert.equal(failed.reconciliationStatus, "failed");

  const declared = validateBankStatement(statement([{ debit: 100, credit: null }], { openingBalance: 1000, closingBalance: 900, declaredDebitTotal: 100.01 }) as never);
  assert.equal(declared.valid, false, "a declared total one cent out is not a pass");
  assert.equal(declared.checks.find((c: { rule: string }) => c.rule === "debit_total")?.ok, false);
});

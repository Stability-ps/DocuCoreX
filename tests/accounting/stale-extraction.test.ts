import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { accountingRunQuality } = await import("@/lib/accounting/run-quality.ts");

// A NULL closing balance was read as ZERO, so the difference became the entire
// opening balance: -992,452.57 + 8,161,114.63 - 7,172,348.61 - 0 = -3,686.55,
// past the R1,000 threshold. A statement that reconciles exactly was declared
// stale forever, and the auto-refresh reprocessed it on a loop.

function detail(run: Record<string, unknown>, transactions: Array<Record<string, unknown>>) {
  return {
    run: { status: "review", statementPeriodStart: null, statementPeriodEnd: null, reconciliationDifference: null, ...run },
    transactions,
  } as never;
}

/** The real statement's shape: opening, and turnover that reconciles. */
const realTotals = [
  { transactionDate: "2025-05-01", debitAmount: 7172348.61, creditAmount: null, bankCharge: false },
  { transactionDate: "2025-05-02", debitAmount: null, creditAmount: 8161114.63, bankCharge: false },
];

test("an unknown closing balance is not treated as zero", () => {
  const quality = accountingRunQuality(detail({ openingBalance: -992452.57, closingBalance: null }, realTotals));
  assert.equal(quality.needsFreshExtraction, false, "unknowable is not evidence of staleness");
  assert.equal(quality.computedDifference, 0, "no difference is claimed");
});

test("a reconciled statement with a known closing balance is not stale", () => {
  const quality = accountingRunQuality(
    detail({ openingBalance: -992452.57, closingBalance: -3686.55 }, realTotals),
  );
  assert.equal(quality.needsFreshExtraction, false);
  assert.ok(Math.abs(quality.computedDifference) < 0.01, "opening + credits - debits lands on closing");
});

test("a genuinely large difference is still detected", () => {
  const quality = accountingRunQuality(
    detail({ openingBalance: -992452.57, closingBalance: -500000 }, realTotals),
  );
  assert.equal(quality.needsFreshExtraction, true, "a real mismatch must still be caught");
  assert.ok(Math.abs(quality.computedDifference) > 1000);
});

test("a processing run is never called stale", () => {
  const quality = accountingRunQuality(detail({ status: "processing", openingBalance: -1, closingBalance: null }, realTotals));
  assert.equal(quality.needsFreshExtraction, false);
});

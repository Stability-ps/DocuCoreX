import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Load the "@/..." path alias so this imports the real accounting logic the
// same way the app does, matching tests/accounting/statements.test.ts.
register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { summarizeMerchants } = await import("@/lib/accounting/analytics.ts");
type AccountingTransaction = import("@/lib/accounting/types.ts").AccountingTransaction;

function txn(overrides: Partial<AccountingTransaction>): AccountingTransaction {
  return {
    id: Math.random().toString(36).slice(2),
    runId: "run-1",
    workspaceId: "ws-1",
    transactionDate: "2025-04-01",
    description: "CARD PURCHASE",
    debitAmount: null,
    creditAmount: null,
    runningBalance: null,
    bankCharge: false,
    accountCategory: "Groceries",
    vatTreatment: "standard",
    supportedByInvoice: false,
    notes: "",
    confidence: 90,
    reviewStatus: "ready",
    classificationSource: "deterministic",
    classificationStrength: null,
    classificationConfidence: null,
    classificationReason: null,
    normalizedMerchant: "Woolworths",
    sourcePage: 1,
    rawText: null,
    createdAt: "2025-04-01T00:00:00Z",
    updatedAt: "2025-04-01T00:00:00Z",
    ...overrides,
  } as AccountingTransaction;
}

test("noisy bank wording collapses to one merchant", () => {
  // The whole point of normalization: three descriptions, one payee.
  const { merchants } = summarizeMerchants([
    txn({ description: "WOOLWORTHS MENLYN 00281", debitAmount: 100 }),
    txn({ description: "WOOLIES 004521", debitAmount: 50 }),
    txn({ description: "WW FOOD 4391", debitAmount: 25 }),
  ]);
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].merchant, "Woolworths");
  assert.equal(merchants[0].transactionCount, 3);
  assert.equal(merchants[0].moneyOut, 175);
});

test("unidentified transactions are counted, never invented into merchants", () => {
  // Grouping these by raw description would fabricate merchant identities the
  // extraction never established.
  const { merchants, unidentifiedCount } = summarizeMerchants([
    txn({ normalizedMerchant: null, description: "PMT 4471" }),
    txn({ normalizedMerchant: "  ", description: "REF 9931" }),
    txn({ normalizedMerchant: "WesBank", debitAmount: 18450 }),
  ]);
  assert.equal(unidentifiedCount, 2);
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].merchant, "WesBank");
});

test("money in and money out are kept apart", () => {
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Acme", debitAmount: 300 }),
    txn({ normalizedMerchant: "Acme", creditAmount: 120 }),
  ]);
  assert.equal(merchants[0].moneyOut, 300);
  assert.equal(merchants[0].moneyIn, 120);
});

test("an unresolved category is not reported as the common category", () => {
  // "Uncategorised" is the absence of a decision. Showing it in a Common
  // Category column would read as a decision that had been made.
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Mystery", accountCategory: "Uncategorised" }),
    txn({ normalizedMerchant: "Mystery", accountCategory: "Suspense / Review Required" }),
  ]);
  assert.equal(merchants[0].commonCategory, null);
  assert.equal(merchants[0].categorySpread, 0);
});

test("resolved categories outvote unresolved ones", () => {
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Shell", accountCategory: "Uncategorised" }),
    txn({ normalizedMerchant: "Shell", accountCategory: "Fuel" }),
  ]);
  assert.equal(merchants[0].commonCategory, "Fuel");
  assert.equal(merchants[0].categorySpread, 1);
});

test("one merchant spanning several treatments is visible as a spread", () => {
  // The counterweight to the feature: identity does not decide treatment.
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Builders", accountCategory: "Repairs & Maintenance" }),
    txn({ normalizedMerchant: "Builders", accountCategory: "Repairs & Maintenance" }),
    txn({ normalizedMerchant: "Builders", accountCategory: "Capital Improvements" }),
  ]);
  assert.equal(merchants[0].categorySpread, 2, "two distinct resolved categories");
  assert.equal(merchants[0].commonCategory, "Repairs & Maintenance");
});

test("last seen is the latest date, and survives missing dates", () => {
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Tracker", transactionDate: "2025-04-07" }),
    txn({ normalizedMerchant: "Tracker", transactionDate: "2025-08-07" }),
    txn({ normalizedMerchant: "Tracker", transactionDate: null }),
  ]);
  assert.equal(merchants[0].lastSeen, "2025-08-07");

  const { merchants: undated } = summarizeMerchants([txn({ normalizedMerchant: "X", transactionDate: null })]);
  assert.equal(undated[0].lastSeen, null, "no date is null, not a fabricated one");
});

test("review required counts every reason a row needs attention", () => {
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Q", reviewStatus: "needs_review" }),
    txn({ normalizedMerchant: "Q", vatTreatment: "review" }),
    txn({ normalizedMerchant: "Q", accountCategory: "Uncategorised" }),
    txn({ normalizedMerchant: "Q" }),
  ]);
  assert.equal(merchants[0].reviewRequiredCount, 3);
  assert.equal(merchants[0].transactionCount, 4);
});

test("ordering is busiest first and stable on ties", () => {
  const { merchants } = summarizeMerchants([
    txn({ normalizedMerchant: "Zeta" }),
    txn({ normalizedMerchant: "Alpha" }),
    txn({ normalizedMerchant: "Busy" }),
    txn({ normalizedMerchant: "Busy" }),
  ]);
  assert.deepEqual(
    merchants.map((m) => m.merchant),
    ["Busy", "Alpha", "Zeta"],
  );
});

test("no transactions is an empty result, not a crash", () => {
  const { merchants, unidentifiedCount } = summarizeMerchants([]);
  assert.deepEqual(merchants, []);
  assert.equal(unidentifiedCount, 0);
});

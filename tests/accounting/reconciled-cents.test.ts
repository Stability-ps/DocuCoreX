import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { buildStatementMetadata } = await import("@/lib/accounting/export.ts");
const { buildAccountingModel, buildTrialBalance } = await import("@/lib/accounting/model.ts");

// "Reconciled" was decided by summing rand in floating point and testing
// `Math.abs(difference) < 0.01`. On a statement that is exactly one cent out the
// float difference often lands just under 0.01 (0.009999999892897904 below), so
// the pack said "Reconciled", difference R0.00, and dropped its draft warning.
// In a random trial of 200,000 one-cent-out statements, 34% passed.

const credits = [32665, 35595.19, 9529.68, 13955.41, 30846.32, 49729.25, 21802.51, 41635.45, 3441.24, 10837.27, 24783.59, 49262.62, 35124.44, 4356.97, 47099.31];
const debits = [19061.13, 36605.5, 20852.03, 13707.55, 43204.6, 7409.28, 18314.34, 37634.48, 15114.94, 45321.41, 33571.17, 38052.35, 21639.38, 15444.56, 13643.73];
const opening = 873902.36;
const toCents = (value: number) => Math.round(value * 100);
const sumCents = (values: number[]) => values.reduce((s, v) => s + toCents(v), 0);
const trueClosing = (toCents(opening) + sumCents(credits) - sumCents(debits)) / 100;
const oneCentOut = 904990.15;

function txn(id: number, o: { credit?: number; debit?: number }) {
  return {
    id: String(id),
    runId: "r1",
    workspaceId: "w1",
    transactionDate: "2026-03-10",
    description: `Row ${id}`,
    debitAmount: o.debit ?? null,
    creditAmount: o.credit ?? null,
    runningBalance: 0,
    bankCharge: false,
    accountCategory: "Uncategorised",
    vatTreatment: "out_of_scope",
    supportedByInvoice: false,
    notes: "",
    confidence: 95,
    reviewStatus: "reviewed",
    sourcePage: 1,
    rawText: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function detailWithClosing(closing: number) {
  const transactions = [...credits.map((credit, i) => txn(i, { credit })), ...debits.map((debit, i) => txn(100 + i, { debit }))];
  const run = {
    id: "run-1",
    workspaceId: "w1",
    documentId: "d1",
    processingJobId: null,
    bank: "FNB",
    statementType: "bank_statement",
    status: "completed",
    companyName: "SYNTHETIC TEST (PTY) LTD",
    accountNumber: "0000000000",
    statementPeriodStart: "2026-03-01",
    statementPeriodEnd: "2026-03-31",
    openingBalance: opening,
    closingBalance: closing,
    transactionCount: transactions.length,
    bankChargesTotal: 0,
    sourceStoragePath: "x",
    workbookStoragePath: null,
    extractionProvider: "python",
    confidence: 96,
    error: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  return { run, transactions } as unknown as Parameters<typeof buildStatementMetadata>[0];
}

test("the fixture is a real trap: the old float check passes it", () => {
  assert.equal(trueClosing, 904990.16);
  const floatDifference = opening + credits.reduce((s, v) => s + v, 0) - debits.reduce((s, v) => s + v, 0) - oneCentOut;
  assert.ok(Math.abs(floatDifference) < 0.01, `float difference ${floatDifference}`);
});

test("a statement one cent out is not reconciled in the export pack", () => {
  const meta = buildStatementMetadata(detailWithClosing(oneCentOut), "SYNTHETIC TEST (PTY) LTD");
  assert.equal(meta.reconciled, false);
  assert.equal(meta.reconciliationDifference, 0.01);
  assert.equal(meta.expectedClosing, trueClosing);
});

test("a statement one cent out is not reconciled in the accounting model", () => {
  const { validation } = buildAccountingModel(detailWithClosing(oneCentOut));
  assert.equal(validation.reconciled, false);
  assert.equal(validation.reconciliationDifference, 0.01);
});

test("a statement that ties out exactly is reconciled, with exact totals", () => {
  const meta = buildStatementMetadata(detailWithClosing(trueClosing), "SYNTHETIC TEST (PTY) LTD");
  assert.equal(meta.reconciled, true);
  assert.equal(meta.reconciliationDifference, 0);
  assert.equal(meta.totalReceipts, sumCents(credits) / 100);
  assert.equal(meta.totalPayments, sumCents(debits) / 100);
  assert.equal(buildAccountingModel(detailWithClosing(trueClosing)).validation.reconciled, true);
});

test("the trial balance is balanced only when debit and credit cents are equal", () => {
  const ledger = (movements: number[]) =>
    movements.map((movement, i) => ({ number: String(1000 + i), name: `A${i}`, movement })) as unknown as Parameters<typeof buildTrialBalance>[0];
  const balanced = buildTrialBalance(ledger([...credits, ...debits.map((d) => -d), -(sumCents(credits) - sumCents(debits)) / 100]));
  assert.equal(balanced.balanced, true);
  assert.equal(balanced.totalDebit, balanced.totalCredit);
  // Debits 104,788.38 against credits 104,788.39: the float difference is
  // -0.00999999999476131, which the old `< 0.01` called balanced.
  const offByOneCent = buildTrialBalance(ledger([65449.31, 39339.07, -27819.78, -47115.36, -29853.25]));
  assert.equal(offByOneCent.balanced, false);
  assert.equal(offByOneCent.totalDebit, 104788.38);
  assert.equal(offByOneCent.totalCredit, 104788.39);
});

import assert from "node:assert/strict";
import test from "node:test";

import { latestBalancesByAccount, summarizeCashflow, type CashflowInput } from "../../lib/accounting/cashflow.ts";

let counter = 0;
function row(overrides: Partial<CashflowInput>): CashflowInput {
  counter += 1;
  return {
    transactionId: `t-${counter}`,
    date: "2025-06-15",
    debit: null,
    credit: null,
    accountCategory: "General",
    bankCharge: false,
    ...overrides,
  };
}

test("inflow, outflow and net are kept distinct", () => {
  const summary = summarizeCashflow([
    row({ credit: 1000 }),
    row({ debit: 400 }),
    row({ debit: 100 }),
  ]);
  assert.equal(summary.totalInflow, 1000);
  assert.equal(summary.totalOutflow, 500);
  assert.equal(summary.netMovement, 500);
});

test("confirmed transfers are excluded from both sides", () => {
  // The failure this prevents: a R50,000 internal transfer counted as both
  // inflow and outflow leaves NET correct while every gross figure is wrong,
  // so the error hides behind a number that looks right.
  const out = row({ debit: 50000, transactionId: "transfer-out" });
  const back = row({ credit: 50000, transactionId: "transfer-in" });
  const real = row({ credit: 8000, transactionId: "real-income" });

  const counted = summarizeCashflow([out, back, real]);
  assert.equal(counted.totalInflow, 58000);
  assert.equal(counted.totalOutflow, 50000);
  assert.equal(counted.netMovement, 8000, "net is right even when the gross figures are not");

  const excluded = summarizeCashflow([out, back, real], new Set(["transfer-out", "transfer-in"]));
  assert.equal(excluded.totalInflow, 8000, "gross inflow is now the real income only");
  assert.equal(excluded.totalOutflow, 0);
  assert.equal(excluded.netMovement, 8000, "net is unchanged, as it must be");
  assert.equal(excluded.excludedTransferCount, 2);
});

test("months are bucketed and ordered", () => {
  const summary = summarizeCashflow([
    row({ date: "2025-08-02", credit: 300 }),
    row({ date: "2025-06-15", credit: 100 }),
    row({ date: "2025-07-01", credit: 200 }),
  ]);
  assert.deepEqual(summary.months.map((m) => m.month), ["2025-06", "2025-07", "2025-08"]);
  assert.equal(summary.months[0].inflow, 100);
  assert.equal(summary.monthsObserved, 3);
  assert.equal(summary.monthsSpanned, 3);
  assert.equal(summary.hasGaps, false);
});

test("a missing month is reported as a gap, not averaged away", () => {
  // July's statement was never uploaded. Dividing by the calendar span would
  // treat July as a zero month; dividing by observed months pretends July never
  // existed. Both counts are reported so the caller can say which it is.
  const summary = summarizeCashflow([
    row({ date: "2025-06-10", credit: 1000 }),
    row({ date: "2025-08-10", credit: 1000 }),
  ]);
  assert.equal(summary.monthsObserved, 2);
  assert.equal(summary.monthsSpanned, 3);
  assert.equal(summary.hasGaps, true);
  assert.equal(summary.averageMonthlyInflow, 1000, "averaged over months actually seen");
});

test("a span across a year boundary is counted correctly", () => {
  const summary = summarizeCashflow([
    row({ date: "2024-11-01", credit: 1 }),
    row({ date: "2025-02-01", credit: 1 }),
  ]);
  assert.equal(summary.monthsSpanned, 4, "Nov, Dec, Jan, Feb");
});

test("categories are attributed to the side money actually moved", () => {
  // A refund posted as a credit must not be counted as expenditure it never was.
  const summary = summarizeCashflow([
    row({ debit: 500, accountCategory: "Repairs" }),
    row({ credit: 120, accountCategory: "Repairs" }),
    row({ credit: 9000, accountCategory: "Revenue" }),
  ]);
  assert.deepEqual(summary.expenseCategories, [{ category: "Repairs", amount: 500, count: 1 }]);
  assert.deepEqual(summary.incomeCategories, [
    { category: "Revenue", amount: 9000, count: 1 },
    { category: "Repairs", amount: 120, count: 1 },
  ]);
});

test("bank charges are tracked separately without leaving the outflow", () => {
  const summary = summarizeCashflow([
    row({ debit: 55, bankCharge: true }),
    row({ debit: 1000 }),
  ]);
  assert.equal(summary.bankChargesTotal, 55);
  assert.equal(summary.totalOutflow, 1055, "a charge is still money that left");
  assert.equal(summary.months[0].bankCharges, 55);
});

test("undated transactions are skipped rather than bucketed somewhere", () => {
  const summary = summarizeCashflow([row({ date: null, credit: 999 }), row({ credit: 1 })]);
  assert.equal(summary.totalInflow, 1);
  assert.equal(summary.monthsObserved, 1);
});

test("no transactions is an empty summary, not a division by zero", () => {
  const summary = summarizeCashflow([]);
  assert.equal(summary.monthsObserved, 0);
  assert.equal(summary.monthsSpanned, 0);
  assert.equal(summary.averageMonthlyInflow, 0);
  assert.equal(summary.averageMonthlyOutflow, 0);
  assert.equal(summary.hasGaps, false);
});

test("balances are reported per account and never summed", () => {
  // Adding closing balances whose statements end on different dates produces a
  // total that was never true on any single day.
  const balances = latestBalancesByAccount([
    { accountLabel: "Business Current", periodEnd: "2025-06-30", closingBalance: 100 },
    { accountLabel: "Business Current", periodEnd: "2025-08-31", closingBalance: 250 },
    { accountLabel: "Savings", periodEnd: "2025-07-31", closingBalance: 900 },
  ]);
  assert.deepEqual(balances, [
    { accountLabel: "Business Current", asAt: "2025-08-31", balance: 250 },
    { accountLabel: "Savings", asAt: "2025-07-31", balance: 900 },
  ]);
  // Each figure carries the date it was true.
  assert.ok(balances.every((entry) => entry.asAt));
});

test("a run with no closing balance contributes nothing", () => {
  const balances = latestBalancesByAccount([
    { accountLabel: "Current", periodEnd: "2025-08-31", closingBalance: null },
  ]);
  assert.deepEqual(balances, [], "an unknown balance is not zero");
});

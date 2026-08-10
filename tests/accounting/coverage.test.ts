import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { buildCoverage, type CoverageStatement, type Engagement } from "../../lib/accounting/coverage.ts";

function stmt(accountLabel: string, month: string, overrides: Partial<CoverageStatement> = {}): CoverageStatement {
  return {
    accountLabel,
    month,
    reconciled: true,
    hasClosingBalance: true,
    transactionCount: 10,
    ...overrides,
  };
}

const NO_ENGAGEMENT: Engagement = { startMonth: null, endMonth: null, expectedAccounts: [] };

test("an interior gap is provably missing", () => {
  // April and June exist, so the account existed across May and a May statement
  // must exist. This is the one gap that needs no engagement to prove.
  const result = buildCoverage([stmt("Current", "2025-04"), stmt("Current", "2025-06")], NO_ENGAGEMENT);
  assert.deepEqual(result.missing, [{ accountLabel: "Current", month: "2025-05" }]);
  assert.deepEqual(result.months, ["2025-04", "2025-05", "2025-06"]);
});

test("an exterior gap is never invented without an engagement", () => {
  // The earliest statement is April. March is only missing if the engagement
  // began before April — the account may simply have been opened in April.
  const result = buildCoverage([stmt("Current", "2025-04"), stmt("Current", "2025-05")], NO_ENGAGEMENT);
  assert.deepEqual(result.missing, [], "nothing before the first or after the last statement");
  assert.equal(result.engagementInferred, true);
  assert.equal(result.coveragePercent, 100);
});

test("a configured engagement makes exterior months accountable", () => {
  const result = buildCoverage([stmt("Current", "2025-04"), stmt("Current", "2025-05")], {
    startMonth: "2025-02",
    endMonth: "2025-06",
    expectedAccounts: [],
  });
  assert.equal(result.engagementInferred, false);
  assert.deepEqual(
    result.missing.map((entry) => entry.month),
    ["2025-02", "2025-03", "2025-06"],
  );
  assert.equal(result.coveragePercent, 40, "2 of 5 months");
});

test("an account opened mid-engagement does not manufacture missing statements", () => {
  // The second account's first statement is July. Without an engagement, June
  // and earlier are not owed by it — otherwise adding a new account would
  // retroactively damage the coverage figure.
  const result = buildCoverage(
    [stmt("Current", "2025-06"), stmt("Current", "2025-07"), stmt("Savings", "2025-07")],
    NO_ENGAGEMENT,
  );
  assert.deepEqual(result.missing, [], "Savings owes nothing for June");
  assert.equal(result.coveragePercent, 100);
  assert.equal(result.accountsTracked, 2);
});

test("an expected account with no statements at all is surfaced", () => {
  // The most important thing this view can show: a whole account never provided.
  const result = buildCoverage([stmt("Current", "2025-04")], {
    startMonth: "2025-04",
    endMonth: "2025-05",
    expectedAccounts: ["Credit Card"],
  });
  const creditCard = result.rows.find((row) => row.accountLabel === "Credit Card");
  assert.ok(creditCard, "an expected account gets a row even with no data");
  assert.equal(creditCard.cells.every((cell) => cell.status === "missing"), true);
  assert.equal(result.missing.filter((entry) => entry.accountLabel === "Credit Card").length, 2);
});

test("statuses distinguish reconciled, present and transactions-only", () => {
  const result = buildCoverage(
    [
      stmt("A", "2025-04", { reconciled: true }),
      stmt("A", "2025-05", { reconciled: false }),
      stmt("A", "2025-06", { reconciled: false, hasClosingBalance: false }),
    ],
    NO_ENGAGEMENT,
  );
  assert.deepEqual(result.rows[0].cells.map((cell) => cell.status), ["reconciled", "present", "transactions_only"]);
  assert.equal(result.statementsReconciled, 1);
  assert.equal(result.statementsReceived, 3);
});

test("transactions-only marks an extraction problem, not a bookkeeping one", () => {
  // No closing balance means reconciliation was never possible, which points at
  // the parser rather than at the books.
  const result = buildCoverage([stmt("A", "2025-04", { reconciled: false, hasClosingBalance: false })], NO_ENGAGEMENT);
  assert.equal(result.rows[0].cells[0].status, "transactions_only");
});

test("a duplicate month keeps the reconciled statement", () => {
  const result = buildCoverage(
    [stmt("A", "2025-04", { reconciled: false }), stmt("A", "2025-04", { reconciled: true })],
    NO_ENGAGEMENT,
  );
  assert.equal(result.rows[0].cells[0].status, "reconciled", "better evidence wins");
});

test("the month range crosses a year boundary correctly", () => {
  const result = buildCoverage([stmt("A", "2024-11"), stmt("A", "2025-02")], NO_ENGAGEMENT);
  assert.deepEqual(result.months, ["2024-11", "2024-12", "2025-01", "2025-02"]);
  assert.deepEqual(
    result.missing.map((entry) => entry.month),
    ["2024-12", "2025-01"],
  );
});

test("no statements yields an empty matrix rather than a divide by zero", () => {
  const result = buildCoverage([], NO_ENGAGEMENT);
  assert.deepEqual(result.months, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.coveragePercent, 0);
  assert.equal(result.accountsTracked, 0);
});

test("an inverted engagement produces nothing rather than looping", () => {
  const result = buildCoverage([stmt("A", "2025-04")], {
    startMonth: "2025-06",
    endMonth: "2025-01",
    expectedAccounts: [],
  });
  assert.deepEqual(result.months, []);
});

test("missing periods are ordered by month for reporting", () => {
  const result = buildCoverage(
    [stmt("Card", "2025-04"), stmt("Card", "2025-07"), stmt("Current", "2025-04"), stmt("Current", "2025-07")],
    NO_ENGAGEMENT,
  );
  assert.deepEqual(result.missing, [
    { accountLabel: "Card", month: "2025-05" },
    { accountLabel: "Current", month: "2025-05" },
    { accountLabel: "Card", month: "2025-06" },
    { accountLabel: "Current", month: "2025-06" },
  ]);
});

test("the engagement migration is workspace-keyed and order-constrained", () => {
  const migration = readFileSync("supabase/migrations/034_accounting_engagement.sql", "utf8");

  // One row per workspace: an engagement is a property of the client
  // relationship, not of a statement or a run, so nothing here cascades away
  // when a reprocess rewrites transactions.
  assert.ok(/workspace_id uuid primary key references public\.workspaces/.test(migration), "one row per workspace");
  assert.ok(!/references public\.accounting_transactions/.test(migration), "must not key to transactions");

  // The expected-accounts list is the only way an account that never arrived
  // can be known about — it leaves no trace in the data.
  assert.ok(/expected_accounts text\[\] not null default/.test(migration));

  assert.ok(/enable row level security/.test(migration), "RLS enabled");
  assert.ok(/create policy .* on public\.accounting_engagement/.test(migration), "RLS policy");
  assert.ok(/check \(start_date is null or end_date is null or start_date <= end_date\)/.test(migration), "period ordered");
});

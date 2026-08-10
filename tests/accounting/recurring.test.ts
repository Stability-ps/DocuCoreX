import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MIN_OCCURRENCES, findRecurringPatterns, type RecurringInput } from "../../lib/accounting/recurring.ts";

let counter = 0;
function payment(merchant: string, date: string, amount: number, category = "Finance / Loan Repayment"): RecurringInput {
  counter += 1;
  return {
    transactionId: `t-${counter}`,
    merchant,
    date,
    debit: amount,
    credit: null,
    accountCategory: category,
  };
}

const WESBANK = [
  payment("WesBank", "2025-06-01", 18450),
  payment("WesBank", "2025-07-01", 18450),
  payment("WesBank", "2025-08-01", 18450),
];

test("a monthly instalment is detected with its next date", () => {
  const [pattern] = findRecurringPatterns(WESBANK);
  assert.equal(pattern.merchant, "WesBank");
  assert.equal(pattern.frequency, "monthly");
  assert.equal(pattern.averageAmount, 18450);
  assert.equal(pattern.lastSeen, "2025-08-01");
  assert.ok(pattern.amountIsStable);
  // Estimated from the observed rhythm, not from a calendar assumption.
  assert.match(pattern.nextExpected, /^2025-08-3\d|^2025-09-0\d/);
});

test("two payments are never a pattern", () => {
  // Two dates are separated by exactly one interval, which is trivially
  // "regular". A commitment claimed from that is coincidence presented as fact.
  assert.equal(findRecurringPatterns(WESBANK.slice(0, 2)).length, 0);
  assert.equal(MIN_OCCURRENCES, 3);
});

test("irregular gaps are not a rhythm even when the median looks tidy", () => {
  // Twice in one month, then nothing for a quarter: the median is monthly-ish
  // while nothing about it recurs.
  const lumpy = [
    payment("Erratic", "2025-01-05", 1000),
    payment("Erratic", "2025-01-20", 1000),
    payment("Erratic", "2025-04-20", 1000),
  ];
  assert.equal(findRecurringPatterns(lumpy).length, 0);
});

test("weekly, fortnightly and quarterly are distinguished", () => {
  const weekly = ["2025-06-02", "2025-06-09", "2025-06-16"].map((d) => payment("Weekly Co", d, 500));
  const fortnightly = ["2025-06-02", "2025-06-16", "2025-06-30"].map((d) => payment("Fortnight Co", d, 500));
  const quarterly = ["2025-01-15", "2025-04-15", "2025-07-15"].map((d) => payment("Quarter Co", d, 500));

  assert.equal(findRecurringPatterns(weekly)[0].frequency, "weekly");
  assert.equal(findRecurringPatterns(fortnightly)[0].frequency, "fortnightly");
  assert.equal(findRecurringPatterns(quarterly)[0].frequency, "quarterly");
});

test("a payment date shifted off a weekend still counts as monthly", () => {
  // Real debit orders move when the date falls on a weekend; a window that only
  // accepted exactly 30 days would reject most genuine monthly commitments.
  const shifted = [
    payment("Insurer", "2025-06-05", 8420),
    payment("Insurer", "2025-07-07", 8420),
    payment("Insurer", "2025-08-05", 8420),
  ];
  assert.equal(findRecurringPatterns(shifted)[0].frequency, "monthly");
});

test("a varying amount is reported as unstable, not hidden", () => {
  const varying = [
    payment("Utility", "2025-06-01", 1000),
    payment("Utility", "2025-07-01", 1400),
    payment("Utility", "2025-08-01", 1200),
  ];
  const [pattern] = findRecurringPatterns(varying);
  assert.equal(pattern.amountIsStable, false);
  assert.ok(pattern.amountVariance > 0.05);
  // Still a real commitment — the rhythm holds even though the amount moves.
  assert.equal(pattern.frequency, "monthly");
});

test("a longer history is more confident than a bare three", () => {
  const long = ["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-05-01", "2025-06-01"].map((d) =>
    payment("Established", d, 5000),
  );
  const short = ["2025-04-01", "2025-05-01", "2025-06-01"].map((d) => payment("New", d, 5000));

  const longConfidence = findRecurringPatterns(long)[0].confidence;
  const shortConfidence = findRecurringPatterns(short)[0].confidence;
  assert.ok(longConfidence > shortConfidence, `${longConfidence} should exceed ${shortConfidence}`);
  assert.ok(shortConfidence < 100, "three occurrences must never reach certainty");
});

test("incoming money is not a commitment", () => {
  // A regular salary credit is a revenue pattern, not an obligation. Mixing the
  // two would let a credit and a debit average into one meaningless figure.
  const credits: RecurringInput[] = ["2025-06-01", "2025-07-01", "2025-08-01"].map((date, i) => ({
    transactionId: `c-${i}`,
    merchant: "Client",
    date,
    debit: null,
    credit: 25000,
    accountCategory: "Revenue",
  }));
  assert.equal(findRecurringPatterns(credits).length, 0);
});

test("unidentified merchants and undated rows are skipped", () => {
  const rows: RecurringInput[] = [
    ...["2025-06-01", "2025-07-01", "2025-08-01"].map((d) => payment("", d, 100)),
    ...["2025-06-01", "2025-07-01", "2025-08-01"].map((d) => ({ ...payment("Ghost", d, 100), date: null })),
  ];
  assert.equal(findRecurringPatterns(rows).length, 0);
});

test("a dismissed merchant stops being offered", () => {
  // "Not recurring" must stick, or the same wrong pattern returns every time.
  assert.equal(findRecurringPatterns(WESBANK, new Set(["wesbank"])).length, 0, "matched case-insensitively");
});

test("the common category is reported without deciding treatment", () => {
  const mixed = [
    payment("Builders", "2025-06-01", 1000, "Repairs & Maintenance"),
    payment("Builders", "2025-07-01", 1000, "Repairs & Maintenance"),
    payment("Builders", "2025-08-01", 1000, "Capital Improvements"),
  ];
  const [pattern] = findRecurringPatterns(mixed);
  assert.equal(pattern.commonCategory, "Repairs & Maintenance");
  // The pattern is about timing; it does not reclassify anything.
  assert.equal(pattern.occurrences.length, 3);
});

test("patterns are ordered by confidence then size", () => {
  const rows = [
    ...["2025-01-01", "2025-02-01", "2025-03-01", "2025-04-01", "2025-05-01", "2025-06-01"].map((d) =>
      payment("Steady", d, 100),
    ),
    ...["2025-04-02", "2025-05-04", "2025-06-01"].map((d) => payment("Wobbly", d, 99000)),
  ];
  const patterns = findRecurringPatterns(rows);
  assert.equal(patterns[0].merchant, "Steady", "regularity and history beat size");
});

test("the decisions migration is merchant-keyed, so it survives a reprocess", () => {
  const migration = readFileSync("supabase/migrations/033_accounting_recurring_decisions.sql", "utf8");

  // The deliberate difference from 031 and 032: those key to transaction ids,
  // which are regenerated on reprocess. A payee's rhythm outlives any single
  // statement, so keying to the merchant makes the decision durable.
  assert.ok(/merchant text not null/.test(migration), "keyed by merchant");
  assert.ok(
    !/references public\.accounting_transactions/.test(migration),
    "must NOT key to a transaction id, which a reprocess regenerates",
  );

  assert.ok(/workspace_id uuid not null references public\.workspaces/.test(migration), "workspace scoping");
  assert.ok(/enable row level security/.test(migration), "RLS enabled");
  assert.ok(/create policy .* on public\.accounting_recurring_decisions/.test(migration), "RLS policy");
  assert.ok(/check \(status in \('confirmed', 'dismissed'\)\)/.test(migration), "dismissals are recorded too");
  assert.ok(/create unique index[\s\S]*lower\(trim\(merchant\)\)/.test(migration), "one decision per merchant, case-insensitive");
  assert.ok(/decided_by uuid references auth\.users/.test(migration), "attributable");
});

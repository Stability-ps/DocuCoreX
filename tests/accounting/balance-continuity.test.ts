import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { computeBalanceContinuity } = await import("@/lib/accounting/balance-continuity.ts");

// The review screen labelled rows "Balance mismatch · possible missing bank
// charge" by taking the first N REVIEW ITEMS — no arithmetic anywhere. On the
// real 615-row Standard Bank statement that put the warning on 488 rows of a
// ledger whose chain has zero gaps.

function tx(over: Record<string, unknown>) {
  return {
    id: String(over.sourceRow ?? Math.random()),
    debitAmount: null, creditAmount: null, runningBalance: null,
    reviewStatus: "needs_review", confidence: 55, bankCharge: false,
    ...over,
  } as never;
}

/** A continuous ledger: opening -1000, four movements, every balance follows. */
function continuousLedger() {
  return [
    tx({ sourceRow: 1, debitAmount: 100, runningBalance: -1100 }),
    tx({ sourceRow: 2, creditAmount: 500, runningBalance: -600 }),
    tx({ sourceRow: 3, debitAmount: 250, runningBalance: -850 }),
    tx({ sourceRow: 4, debitAmount: 50, runningBalance: -900 }),
  ];
}

test("a reconciling ledger produces no warnings, however many rows need review", () => {
  // Every row here is needs_review at low confidence — the exact population the
  // old code flagged. None of them breaks the chain.
  const result = computeBalanceContinuity(continuousLedger(), -1000);
  assert.equal(result.verified, true);
  assert.equal(result.mismatchedIds.size, 0, "review status must not produce balance warnings");
});

test("the 488-review-rows case produces zero balance warnings", () => {
  // Scaled version of the production statement: many review rows, chain intact.
  const rows = [];
  let balance = -1000;
  for (let i = 1; i <= 488; i += 1) {
    balance -= 10;
    rows.push(tx({ sourceRow: i, debitAmount: 10, runningBalance: balance, reviewStatus: "needs_review" }));
  }
  const result = computeBalanceContinuity(rows as never, -1000);
  assert.equal(result.verified, true);
  assert.equal(result.mismatchedIds.size, 0, "488 review rows, 0 balance warnings");
});

test("a missing transaction flags exactly the row where the chain jumps", () => {
  // The real failure mode: a movement was never extracted, so the printed
  // balances are all correct but one step is larger than its own amount.
  const rows = [
    tx({ sourceRow: 1, debitAmount: 100, runningBalance: -1100 }),
    // A R400 movement between these two was missed; row 2 still prints the
    // bank's true balance.
    tx({ sourceRow: 2, debitAmount: 250, runningBalance: -1750 }),
    tx({ sourceRow: 3, debitAmount: 50, runningBalance: -1800 }),
  ];
  const result = computeBalanceContinuity(rows, -1000);
  assert.equal(result.verified, true);
  assert.deepEqual([...result.mismatchedIds], ["2"], "one missing movement flags one row");
});

test("a corrupted printed balance flags the pair, and does not cascade beyond it", () => {
  // A misread balance is genuinely ambiguous: either this row's balance is
  // wrong, or the next row's is. Flagging both is honest. What matters is that
  // it stops there rather than condemning every row after it.
  const rows = continuousLedger();
  (rows[1] as unknown as { runningBalance: number }).runningBalance = -700;
  const result = computeBalanceContinuity(rows, -1000);
  assert.equal(result.mismatchedIds.size, 2, "the ambiguous pair, not the whole tail");
  assert.deepEqual([...result.mismatchedIds].sort(), ["2", "3"]);
  assert.ok(!result.mismatchedIds.has("4"), "the chain re-anchors and row 4 is clean");
});

test("nothing is claimed when canonical order is unavailable", () => {
  // Rows written before source_row was persisted. Sorting by date or insertion
  // time produced 513 and 615 phantom gaps on a ledger with none, so the honest
  // answer is that the chain cannot be verified.
  const rows = continuousLedger().map((r) => ({ ...(r as object), sourceRow: null })) as never;
  const result = computeBalanceContinuity(rows, -1000);
  assert.equal(result.verified, false);
  assert.equal(result.mismatchedIds.size, 0, "unverifiable must mean silent, not alarming");
  assert.match(result.reason, /canonical order/);
});

test("nothing is claimed without an opening balance or printed balances", () => {
  assert.equal(computeBalanceContinuity(continuousLedger(), null).verified, false);
  const noBalances = continuousLedger().map((r) => ({ ...(r as object), runningBalance: null })) as never;
  assert.equal(computeBalanceContinuity(noBalances, -1000).verified, false);
  assert.equal(computeBalanceContinuity([], -1000).verified, false);
});

test("rounding to the cent does not manufacture a mismatch", () => {
  const rows = [
    tx({ sourceRow: 1, debitAmount: 0.1, runningBalance: -1000.1 }),
    tx({ sourceRow: 2, debitAmount: 0.2, runningBalance: -1000.3 }),
  ];
  assert.equal(computeBalanceContinuity(rows, -1000).mismatchedIds.size, 0, "0.1 + 0.2 must not break the chain");
});

test("the UI derives the warning from arithmetic, not from review status", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /computeBalanceContinuity\(transactions/, "the chain is computed");
  assert.match(ui, /balanceContinuity\.mismatchedIds\.has\(transaction\.id\)/, "and drives the flag");
  assert.ok(!/reviewItems\.slice\(0, estimatedAffectedRows\)/.test(ui), "review items must not be the source");
  assert.ok(!/const estimatedAffectedRows/.test(ui), "the estimate that sized the fake set is gone");
});

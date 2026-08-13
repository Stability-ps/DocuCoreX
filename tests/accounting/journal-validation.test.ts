import test from "node:test";
import assert from "node:assert/strict";
import { validateJournalLines } from "../../lib/accounting/journals.ts";

/**
 * These rules also exist in the database, which is where they are ENFORCED.
 * This suite covers the copy the accountant actually meets — the one that has
 * to explain the problem before they submit rather than after.
 *
 * Unlike the migration tests, this code executes.
 */

const account = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";

const balanced = [
  { accountId: account, debit: 120000, credit: 0 },
  { accountId: other, debit: 0, credit: 120000 },
];

test("a balanced journal has nothing to report", () => {
  assert.deepEqual(validateJournalLines(balanced), []);
});

test("an unbalanced journal names the difference", () => {
  const errors = validateJournalLines([
    { accountId: account, debit: 120000, credit: 0 },
    { accountId: other, debit: 0, credit: 119000 },
  ]);
  // The difference is the number the accountant needs; "does not balance" alone
  // makes them work it out themselves.
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /difference 1000\.00/);
});

test("cents balance exactly, without floating-point slack", () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point. Summed as cents it does, which
  // is why the rule works in integers: a journal that is right must not be
  // rejected for a rounding artefact, and a journal that is a cent out must not
  // be accepted because the artefact happened to cancel.
  assert.deepEqual(
    validateJournalLines([
      { accountId: account, debit: 0.1, credit: 0 },
      { accountId: account, debit: 0.2, credit: 0 },
      { accountId: other, debit: 0, credit: 0.3 },
    ]),
    [],
  );

  const off = validateJournalLines([
    { accountId: account, debit: 0.1, credit: 0 },
    { accountId: other, debit: 0, credit: 0.11 },
  ]);
  assert.equal(off.length, 1);
  assert.match(off[0].message, /difference 0\.01/);
});

test("a line is a debit or a credit, never both and never neither", () => {
  const both = validateJournalLines([
    { accountId: account, debit: 100, credit: 100 },
    { accountId: other, debit: 0, credit: 100 },
  ]);
  assert.ok(both.some((issue) => issue.line === 1 && /either a debit or a credit/.test(issue.message)));

  const neither = validateJournalLines([
    { accountId: account, debit: 0, credit: 0 },
    { accountId: other, debit: 0, credit: 100 },
  ]);
  assert.ok(neither.some((issue) => issue.line === 1 && /Enter a debit or a credit/.test(issue.message)));
});

test("a negative amount is refused rather than silently flipped", () => {
  // Accepting -100 as a debit and storing it as a credit would mean the journal
  // the accountant reviews is not the journal that posts.
  const errors = validateJournalLines([
    { accountId: account, debit: -100, credit: 0 },
    { accountId: other, debit: 0, credit: 100 },
  ]);
  assert.ok(errors.some((issue) => issue.line === 1 && /magnitudes/.test(issue.message)));
});

test("a journal of zero cannot post even though it balances", () => {
  // Zero debits equal zero credits, so the balance rule alone would let this
  // through. It records nothing and would still occupy the ledger.
  const errors = validateJournalLines([
    { accountId: account, debit: 0, credit: 0 },
    { accountId: other, debit: 0, credit: 0 },
  ]);
  assert.ok(errors.some((issue) => /journal of zero/.test(issue.message)));
});

test("an empty journal is refused", () => {
  const errors = validateJournalLines([]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /at least one line/);
});

test("a line without an account is refused", () => {
  const errors = validateJournalLines([
    { accountId: "", debit: 100, credit: 0 },
    { accountId: other, debit: 0, credit: 100 },
  ]);
  assert.ok(errors.some((issue) => issue.line === 1 && /Choose an account/.test(issue.message)));
});

test("errors are reported per line so a long journal can be fixed", () => {
  const errors = validateJournalLines([
    { accountId: "", debit: 0, credit: 0 },
    { accountId: other, debit: 50, credit: 50 },
    { accountId: account, debit: 0, credit: 100 },
  ]);
  assert.ok(errors.some((issue) => issue.line === 1));
  assert.ok(errors.some((issue) => issue.line === 2));
});

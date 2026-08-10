import assert from "node:assert/strict";
import test from "node:test";

import { deriveClosingBalance, parseStatementMetadata } from "../../lib/pdf/metadata.ts";

/**
 * A Standard Bank statement, in the shape the production run showed: an
 * overdrawn opening balance printed hard against a minus sign, a Deposits /
 * Payments summary block instead of "Credit/Debit Transactions", and no
 * "Closing Balance" label anywhere.
 */
const STANDARD_BANK = `
STANDARD BANK OF SOUTH AFRICA
Account Number : 123456789
From : 01 April 2025
To : 30 April 2025

STATEMENT OPENING BALANCE -992,452.57

Deposits    419,700.00
Payments   -420,080.00

01 Apr  ADT JHB ACCOUNT PAYMENT   380.00   -992,832.57
`;

test("an overdrawn opening balance keeps its minus sign", () => {
  // The defect: `[:\\-]?` treated the minus as punctuation separating the label
  // from the figure, so -992,452.57 was read as +992,452.57. Every balance check
  // then failed by twice the opening balance. The worker fixed this in its own
  // parser; the same bug survived on this side.
  const metadata = parseStatementMetadata(STANDARD_BANK);
  assert.equal(metadata.openingBalance, -992452.57);
});

test("a positive opening balance is unaffected", () => {
  const metadata = parseStatementMetadata("Opening Balance: R 12,345.67\n");
  assert.equal(metadata.openingBalance, 12345.67);
});

test("a dash used as a separator is still a separator", () => {
  // "Opening Balance - 500.00" is punctuation; "Opening Balance -500.00" is a
  // negative figure. The space is what distinguishes them.
  assert.equal(parseStatementMetadata("Opening Balance - 500.00\n").openingBalance, 500);
  assert.equal(parseStatementMetadata("Opening Balance -500.00\n").openingBalance, -500);
});

test("Standard Bank's Deposits and Payments block is read as declared totals", () => {
  const metadata = parseStatementMetadata(STANDARD_BANK);
  assert.equal(metadata.declaredCreditTotal, 419700);
  // The minus on Payments is the bank showing an outflow, not a negative total.
  assert.equal(metadata.declaredDebitTotal, 420080);
});

test("a statement with no Closing Balance label still has a closing balance", () => {
  // The production failure: rejected as "Closing balance is missing", which sent
  // the run up the escalation ladder to Azure, Mistral and tesseract — none of
  // which can find a label that was never printed.
  const metadata = parseStatementMetadata(STANDARD_BANK);
  assert.equal(metadata.closingBalance, null, "there is genuinely no label");

  const derived = deriveClosingBalance(metadata, [
    { date: "01 Apr", description: "ADT JHB", amount: -380, balance: -992832.57 },
  ] as never);
  assert.equal(derived.source, "last_running_balance_verified");
  assert.equal(derived.closingBalance, -992832.57);
});

test("an explicit label always wins over derivation", () => {
  const metadata = parseStatementMetadata("Opening Balance 100.00\nClosing Balance 250.00\n");
  const derived = deriveClosingBalance(metadata, [{ balance: 999 }] as never);
  assert.equal(derived.source, "explicit");
  assert.equal(derived.closingBalance, 250);
});

test("derivation is refused when the bank's own figures disagree", () => {
  // The guard that stops this becoming a confident wrong number. A mis-parsed
  // final row would otherwise be accepted as the closing balance, and closing is
  // what every downstream reconciliation is measured against.
  const metadata = parseStatementMetadata(STANDARD_BANK);
  const derived = deriveClosingBalance(metadata, [{ balance: -900000 }] as never);
  assert.equal(derived.source, "unverified");
  assert.equal(derived.closingBalance, null, "an unknown closing balance is safer than a plausible wrong one");
});

test("derivation is refused when a declared total is absent", () => {
  const metadata = parseStatementMetadata("Opening Balance 100.00\n");
  const derived = deriveClosingBalance(metadata, [{ balance: 500 }] as never);
  assert.equal(derived.source, "unavailable");
  assert.equal(derived.closingBalance, null);
});

test("derivation is refused when no row carries a running balance", () => {
  const metadata = parseStatementMetadata(STANDARD_BANK);
  const derived = deriveClosingBalance(metadata, [{ balance: null }] as never);
  assert.equal(derived.source, "unavailable");
});

test("the cent tolerance matches the worker, and does not absorb a missing transaction", () => {
  const metadata = parseStatementMetadata(STANDARD_BANK);
  const expected = -992452.57 + 419700 - 420080;

  assert.equal(deriveClosingBalance(metadata, [{ balance: expected + 0.04 }] as never).source, "last_running_balance_verified");
  assert.equal(deriveClosingBalance(metadata, [{ balance: expected + 0.5 }] as never).source, "unverified");
});

test("Balance Brought/Carried Forward are accepted as labels", () => {
  const metadata = parseStatementMetadata("Balance Brought Forward 1,000.00\nBalance Carried Forward 2,000.00\n");
  assert.equal(metadata.openingBalance, 1000);
  assert.equal(metadata.closingBalance, 2000);
});

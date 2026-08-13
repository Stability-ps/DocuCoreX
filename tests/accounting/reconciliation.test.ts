import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  confidenceLabel,
  groupMatchStatus,
  isAccountingError,
  reconciliationStatement,
  suggestMatches,
  type UnmatchedBankItem,
  type UnmatchedLedgerEntry,
} from "../../lib/accounting/reconciliation.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/039_accounting_bank_reconciliation.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

const bank = (over: Partial<UnmatchedBankItem> = {}): UnmatchedBankItem => ({
  transactionId: "t1", date: "2026-07-22", description: "PAYMENT ABC SUPPLIERS",
  reference: null, amount: 15000, runId: "r1", ...over,
});
const ledger = (over: Partial<UnmatchedLedgerEntry> = {}): UnmatchedLedgerEntry => ({
  postingId: "p1", date: "2026-07-22", description: "ABC Suppliers",
  journalReference: null, amount: 15000, ...over,
});

// ── Matching ────────────────────────────────────────────────────────────────

test("amount must agree to the cent", () => {
  // Necessary, not sufficient. "Close enough" matching is how a reconciliation
  // silently absorbs a real error.
  assert.equal(suggestMatches([bank({ amount: 15000 })], [ledger({ amount: 15000.01 })]).length, 0);
  assert.equal(suggestMatches([bank()], [ledger()]).length, 1);
});

test("a same-date, same-amount, similar-description match reads as high confidence", () => {
  const [suggestion] = suggestMatches([bank()], [ledger()]);
  assert.equal(suggestion.postingId, "p1");
  assert.equal(confidenceLabel(suggestion.confidence), "High");
  assert.ok(suggestion.reasons.includes("Amount agrees to the cent"));
  assert.ok(suggestion.reasons.includes("Same date"));
});

test("confidence never reaches certainty, because a person confirms", () => {
  const [suggestion] = suggestMatches(
    [bank({ reference: "INV-100" })],
    [ledger({ journalReference: "INV-100" })],
  );
  assert.ok(suggestion.confidence <= 95, `expected <= 95, got ${suggestion.confidence}`);
});

test("a date far apart is not suggested at all", () => {
  assert.equal(suggestMatches([bank({ date: "2026-07-01" })], [ledger({ date: "2026-08-30" })]).length, 0);
  const near = suggestMatches([bank({ date: "2026-07-20" })], [ledger({ date: "2026-07-22" })]);
  assert.equal(near.length, 1);
  assert.ok(near[0].reasons.some((reason) => /2 days apart/.test(reason)));
});

test("ambiguity lowers confidence rather than being resolved silently", () => {
  // Two identical candidates: the system does not know which is right, and
  // must not present a guess as a strong match.
  const [suggestion] = suggestMatches(
    [bank()],
    [ledger({ postingId: "p1" }), ledger({ postingId: "p2" })],
  );
  assert.equal(confidenceLabel(suggestion.confidence), "Low");
  assert.ok(suggestion.reasons.includes("Several entries match equally well"));
});

test("one ledger entry is not offered to two bank items", () => {
  const suggestions = suggestMatches(
    [bank({ transactionId: "t1" }), bank({ transactionId: "t2" })],
    [ledger({ postingId: "p1" })],
  );
  assert.equal(suggestions.length, 1);
});

test("suggestions do not depend on the order rows came back in", () => {
  const items = [bank({ transactionId: "t2", date: "2026-07-23" }), bank({ transactionId: "t1", date: "2026-07-22" })];
  const entries = [ledger({ postingId: "p2", date: "2026-07-23" }), ledger({ postingId: "p1", date: "2026-07-22" })];
  const forward = suggestMatches(items, entries);
  const reversed = suggestMatches([...items].reverse(), [...entries].reverse());
  assert.deepEqual(forward, reversed);
});

// ── The reconciliation statement ────────────────────────────────────────────

test("statement ± reconciling items = ledger", () => {
  const result = reconciliationStatement({
    statementBalance: 842455,
    ledgerBalance: 836205,
    bankSideItems: [6250],
    ledgerSideItems: [],
  });
  assert.equal(result.unexplained, 0);
  assert.equal(result.explained, true);
});

test("an unexplained residual is reported, not rounded away", () => {
  const result = reconciliationStatement({
    statementBalance: 842455,
    ledgerBalance: 836205,
    bankSideItems: [],
    ledgerSideItems: [],
  });
  assert.equal(result.unexplained, 6250);
  assert.equal(result.explained, false);
});

test("the residual is computed in cents", () => {
  // Summed as floats, 0.1 + 0.2 leaves 5.6e-17 — which displays as 0.00 and
  // would let a reconciliation declare itself explained when it is not.
  const result = reconciliationStatement({
    statementBalance: 0.3,
    ledgerBalance: 0,
    bankSideItems: [0.1, 0.2],
    ledgerSideItems: [],
  });
  assert.equal(result.unexplained, 0);
  assert.equal(result.explained, true);

  const cent = reconciliationStatement({
    statementBalance: 0.3,
    ledgerBalance: 0,
    bankSideItems: [0.1, 0.19],
    ledgerSideItems: [],
  });
  assert.equal(cent.unexplained, 0.01);
  assert.equal(cent.explained, false);
});

// ── The distinction that matters ────────────────────────────────────────────

test("a missing posting is an accounting error, not a reconciling item", () => {
  assert.equal(isAccountingError("missing_posting"), true);
  assert.equal(isAccountingError("timing_difference"), false);
  assert.equal(isAccountingError("missing_bank_item"), false);
});

test("the database refuses to complete over an unresolved missing posting", () => {
  const complete = sql.slice(sql.indexOf("function public.accounting_complete_reconciliation"));
  assert.match(complete, /item_type = 'missing_posting'/);
  assert.match(complete, /resolving_journal_id is null/);
  assert.match(complete, /raise exception/);
  // And timing differences DO explain the difference.
  assert.match(complete, /item_type in \('timing_difference', 'missing_bank_item'\)/);
});

test("completion requires the difference to be explained, not merely zero", () => {
  const complete = sql.slice(sql.indexOf("function public.accounting_complete_reconciliation"));
  assert.match(complete, /residual := \(statement_balance_input - bank_side \+ ledger_side\) - ledger_balance/);
  assert.match(complete, /if residual <> 0 then/);
  // Exact, like a balanced journal.
  assert.doesNotMatch(complete, /abs\(residual\)/);
});

// ── Schema rules ────────────────────────────────────────────────────────────

test("the ledger balance is derived, never stored on the mapping", () => {
  // §1: a stored copy would be a third number able to disagree with both the
  // statement and the ledger.
  assert.match(sql, /function public\.accounting_bank_ledger_balance/);
  // The function reaches postings by joining from the mapping, so the check is
  // scoped to its body rather than looking for a bare FROM.
  const balanceFn = sql.slice(sql.indexOf("function public.accounting_bank_ledger_balance"));
  assert.match(balanceFn, /join public\.accounting_postings/);
  assert.match(balanceFn, /p\.debit - p\.credit/);
  const bankAccounts = sql.slice(sql.indexOf("create table if not exists public.accounting_bank_accounts"), sql.indexOf("create unique index"));
  assert.doesNotMatch(bankAccounts, /balance/i);
});

test("a bank account cannot map to another entity's ledger account", () => {
  assert.match(
    sql,
    /accounting_bank_accounts_ledger_same_entity[\s\S]{0,160}foreign key \(ledger_account_id, company_id\)[\s\S]{0,120}references public\.accounting_accounts \(id, company_id\)/,
  );
});

test("reconciliation never writes a posting directly", () => {
  // §8: a discovered entry is created as a JOURNAL and goes through the gate.
  assert.doesNotMatch(sql, /insert into public\.accounting_postings/);
});

test("a completed reconciliation is frozen", () => {
  assert.match(sql, /create trigger accounting_reconciliation_items_guard/);
  assert.match(sql, /reconciliation_status = 'completed'/);
  assert.match(sql, /this reconciliation is already completed/);
});

test("one reconciliation per bank account per period", () => {
  assert.match(sql, /accounting_reconciliations_unique_period[\s\S]{0,140}\(bank_account_id, period_start, period_end\)/);
});

test("the migration is non-destructive", () => {
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /truncate/i);
  for (const drop of sql.match(/drop (policy|constraint|trigger)[^;]*/gi) ?? []) {
    assert.match(drop, /if exists/i);
  }
});

// ── Group matching ──────────────────────────────────────────────────────────

test("one bank item may answer to several ledger entries", () => {
  // A single transfer paying four invoices. Forcing this into pairs would
  // either lose the relationship or invent three bank lines.
  const status = groupMatchStatus({ bankAmounts: [10000], ledgerAmounts: [2500, 2500, 2500, 2500] });
  assert.equal(status.canMatch, true);
  assert.equal(status.difference, 0);
  assert.match(status.reason, /1 bank item against 4 ledger entries/);
});

test("several bank items may answer to one ledger entry", () => {
  const status = groupMatchStatus({ bankAmounts: [3000, 7000], ledgerAmounts: [10000] });
  assert.equal(status.canMatch, true);
});

test("a group that does not agree to the cent is not a match", () => {
  const status = groupMatchStatus({ bankAmounts: [10000], ledgerAmounts: [2500, 2500, 2500, 2499.99] });
  assert.equal(status.canMatch, false);
  assert.equal(status.difference, 0.01);
  assert.match(status.reason, /agree to the cent/);
});

test("group totals are summed in cents", () => {
  const status = groupMatchStatus({ bankAmounts: [0.1, 0.2], ledgerAmounts: [0.3] });
  assert.equal(status.canMatch, true);
  assert.equal(status.difference, 0);
});

test("a one-sided selection cannot be matched", () => {
  assert.equal(groupMatchStatus({ bankAmounts: [100], ledgerAmounts: [] }).canMatch, false);
  assert.equal(groupMatchStatus({ bankAmounts: [], ledgerAmounts: [100] }).canMatch, false);
  assert.match(groupMatchStatus({ bankAmounts: [], ledgerAmounts: [] }).reason, /at least one item on each side/);
});

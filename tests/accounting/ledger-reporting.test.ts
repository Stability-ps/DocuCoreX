import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { financialYearFor, toCsv, trialBalanceTotals, type TrialBalanceRow } from "../../lib/accounting/ledger.ts";
import { formatLedgerMoney } from "../../lib/accounting/format.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/038_accounting_ledger_reporting.sql"), "utf8");
const ledgerServer = readFileSync(join(root, "lib/accounting/ledger-server.ts"), "utf8");
const trialBalanceUi = readFileSync(join(root, "components/accounting/trial-balance.tsx"), "utf8");

const row = (over: Partial<TrialBalanceRow> = {}): TrialBalanceRow => ({
  accountId: "a", code: "1000", name: "Bank", accountType: "asset", normalBalance: "debit",
  debits: 0, credits: 0, closingBalance: 0, postingCount: 1, ...over,
});

// ── Balance integrity ───────────────────────────────────────────────────────

test("a trial balance balances only when it balances exactly", () => {
  assert.equal(trialBalanceTotals([row({ debits: 1000 }), row({ credits: 1000 })]).balanced, true);

  const off = trialBalanceTotals([row({ debits: 1000 }), row({ credits: 999.99 })]);
  assert.equal(off.balanced, false);
  assert.equal(off.difference, 0.01);
});

test("balance is decided in cents, not by a rounded display value", () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point. Summed naively the difference
  // would be 5.6e-17 — which formats as "R 0.00" and would be declared
  // balanced by anything comparing the displayed string.
  const totals = trialBalanceTotals([
    row({ debits: 0.1 }), row({ debits: 0.2 }), row({ credits: 0.3 }),
  ]);
  assert.equal(totals.balanced, true);
  assert.equal(totals.difference, 0);

  // And the converse: a genuine one-cent error must not be absorbed.
  const cent = trialBalanceTotals([row({ debits: 0.1 }), row({ credits: 0.11 })]);
  assert.equal(cent.balanced, false);
  assert.equal(formatLedgerMoney(cent.difference), "(R0.01)");
});

test("a trial balance of nothing is balanced but empty", () => {
  const totals = trialBalanceTotals([]);
  assert.equal(totals.balanced, true);
  assert.equal(totals.totalDebits, 0);
  // The UI must not render this as a valid trial balance — see the empty-state
  // test below.
});

// ── Presentation ────────────────────────────────────────────────────────────

test("money is South African, and negatives are bracketed", () => {
  // Grouping matches the rest of the product exactly — the first version of
  // this used a different locale and produced "R 1 245 821,55", a second money
  // format in one application.
  assert.equal(formatLedgerMoney(1245821.55), "R1,245,821.55");
  assert.equal(formatLedgerMoney(-42880), "(R42,880.00)");
  assert.equal(formatLedgerMoney(0), "R0.00");
  // Zero is blanked only where a blank column is the accounting convention.
  assert.equal(formatLedgerMoney(0, { blankZero: true }), "");
  assert.equal(formatLedgerMoney(0.004, { blankZero: true }), "", "sub-cent rounds to zero and blanks");
});

test("a CSV export survives an account name containing a comma or a quote", () => {
  const csv = toCsv(["Code", "Account", "Debit"], [["4000", 'Consulting, "special"', 1500.5]]);
  const [, dataLine] = csv.split("\r\n");
  assert.equal(dataLine, '"4000","Consulting, ""special""",1500.5');
  // Amounts are unquoted so a spreadsheet reads them as numbers.
  assert.ok(!dataLine.includes('"1500.5"'));
});

// ── Financial year derivation ───────────────────────────────────────────────

test("the default period is the entity's financial year, not the calendar year", () => {
  // A South African company closing 28 February does not report Jan–Dec.
  const mid = financialYearFor(2, 28, new Date("2026-08-13T00:00:00Z"));
  assert.deepEqual(mid, { from: "2026-03-01", to: "2027-02-28" });

  // Before the year-end, the period still ends this calendar year.
  const early = financialYearFor(2, 28, new Date("2026-01-15T00:00:00Z"));
  assert.deepEqual(early, { from: "2025-03-01", to: "2026-02-28" });

  // A December year-end behaves like the calendar year.
  const december = financialYearFor(12, 31, new Date("2026-06-01T00:00:00Z"));
  assert.deepEqual(december, { from: "2026-01-01", to: "2026-12-31" });
});

// ── The rule the whole stage exists to keep ─────────────────────────────────

test("reports read postings and nothing else", () => {
  // A report that consulted accounting_transactions, account_category or a
  // statement's closing balance would not be a report of the books.
  assert.ok(!/from public\.accounting_transactions/.test(migration.replace(/--[^\n]*/g, "")),
    "reporting functions must not read bank transactions as a source of amounts");
  assert.match(migration, /from public\.accounting_postings/);

  // The only join to accounting_transactions is the LEFT join that resolves a
  // source reference for drill-down — it contributes no amount.
  // Matched on whole lines: /join …/ also matches inside "left join …", so a
  // fragment match would report a plain join that is not there.
  const joins = (migration.split("\n").filter((line) => /\bjoin public\.accounting_transactions\b/.test(line)));
  assert.equal(joins.length, 1, "exactly one reference to the transactions table");
  assert.match(joins[0].trim(), /^left join/, "it must be a LEFT join, contributing no amount");

  // And the server module aggregates nothing itself.
  assert.doesNotMatch(ledgerServer, /\.from\("accounting_transactions"\)/);
  assert.doesNotMatch(ledgerServer, /reduce\([^)]*debit/);
});

test("the adjusted trial balance is a filter over the same ledger, not a second store", () => {
  // §32: adjustments are journals, so they are already in the ledger. A stored
  // "adjusted balance" column could disagree with the postings it came from.
  assert.match(migration, /include_adjustments boolean default true/);
  assert.match(migration, /journal_type in \('adjustment', 'closing'\)/);
  assert.doesNotMatch(migration, /create table/i);
});

test("an account with no postings is absent, not reported as zero", () => {
  // §31. Listing every account in the chart at R0.00 states that the period was
  // examined and found empty — a different claim from "nothing was posted".
  assert.match(migration, /having count\(p\.id\) > 0/);
});

test("the trial balance never fabricates comparatives or AFS mapping", () => {
  // §33: a prior-year zero would assert that last year was nil. §29: mapping
  // belongs to a later stage.
  assert.match(trialBalanceUi, /Not imported/);
  assert.match(trialBalanceUi, /Not mapped/);
  assert.doesNotMatch(trialBalanceUi, /priorYear[^:]*:\s*0/);
});

test("an empty trial balance is an empty state, not a balanced report", () => {
  // The totals of nothing are balanced, so a naive render would show a green
  // BALANCED banner over an empty table.
  const emptyBranch = trialBalanceUi.slice(trialBalanceUi.indexOf("!rows.length"));
  assert.match(emptyBranch.slice(0, 200), /EmptyTrialBalance/);
  assert.match(trialBalanceUi, /No trial balance is available yet/);
  assert.match(trialBalanceUi, /generated from posted ledger entries/);
});

test("the ledger is paged server-side", () => {
  // §35: the browser must never receive the whole ledger.
  assert.match(ledgerServer, /page_limit/);
  assert.match(ledgerServer, /page_offset/);
  assert.match(ledgerServer, /Math\.min\(Math\.max\(filters\.limit \?\? 100, 1\), 500\)/);
  // total_rows must come from the query, not from the returned page length.
  assert.match(ledgerServer, /total_rows/);
  assert.doesNotMatch(ledgerServer, /totalRows = rows\.length/);
});

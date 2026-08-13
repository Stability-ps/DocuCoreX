import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vatPosition, vatReadiness, type VatSummaryRow } from "../../lib/accounting/vat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/040_accounting_tax_codes_and_vat.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");
const vatServer = readFileSync(join(root, "lib/accounting/vat-server.ts"), "utf8");
const workspace = readFileSync(join(root, "components/accounting/vat-workspace.tsx"), "utf8");

const row = (over: Partial<VatSummaryRow> = {}): VatSummaryRow => ({
  taxCodeId: "c1", code: "STD-IN", name: "Standard-rated received", direction: "input",
  rate: 15, isCapital: false, vat201Box: "14", controlAccountMapped: true,
  netAmount: 0, vatAmount: 0, postingCount: 1, ...over,
});

// ── The position ────────────────────────────────────────────────────────────

test("net VAT is output less input", () => {
  const position = vatPosition([
    row({ code: "STD-OUT", direction: "output", vatAmount: 341220 }),
    row({ code: "STD-IN", direction: "input", vatAmount: 214778 }),
  ]);
  assert.equal(position.outputVat, 341220);
  assert.equal(position.inputVat, 214778);
  assert.equal(position.netVat, 126442);
  assert.equal(position.payable, true);
});

test("a refund position is reported as refundable, not as a negative payable", () => {
  const position = vatPosition([
    row({ direction: "output", vatAmount: 100 }),
    row({ direction: "input", vatAmount: 250 }),
  ]);
  assert.equal(position.netVat, -150);
  assert.equal(position.payable, false);
});

test("the position is summed in cents", () => {
  // A VAT return is filed to the cent. Summed as floats, 0.1 + 0.2 leaves
  // 5.6e-17 — invisible on screen, wrong on a return.
  const position = vatPosition([
    row({ direction: "output", vatAmount: 0.1 }),
    row({ direction: "output", vatAmount: 0.2 }),
    row({ direction: "input", vatAmount: 0.3 }),
  ]);
  assert.equal(position.netVat, 0);
});

test("codes that arise no VAT do not affect the position", () => {
  const position = vatPosition([
    row({ direction: "output", vatAmount: 750 }),
    row({ code: "EXE", direction: "none", netAmount: 5000, vatAmount: 0, controlAccountMapped: false }),
  ]);
  assert.equal(position.netVat, 750);
  // And a 'none' code without a control account is not flagged — it correctly
  // has nowhere to post VAT because no VAT arises.
  assert.deepEqual(position.unmappedCodes, []);
});

test("a VAT-bearing code with no control account is flagged, not treated as nil", () => {
  const position = vatPosition([
    row({ code: "IMP-SVC", direction: "input", vatAmount: 0, controlAccountMapped: false }),
  ]);
  assert.deepEqual(position.unmappedCodes, ["IMP-SVC"]);
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("a return is not ready while transactions await review", () => {
  const rows = [row({ direction: "output", vatAmount: 750 })];
  const { ready, checks } = vatReadiness({
    rows,
    position: vatPosition(rows),
    transactionsAwaitingReview: 12,
    periodLocked: false,
  });
  assert.equal(ready, false);
  assert.ok(checks.some((check) => check.state === "blocked" && /awaiting review/.test(check.label)));
});

test("a return is not ready while a used code has no control account", () => {
  const rows = [row({ code: "IMP-SVC", direction: "input", controlAccountMapped: false })];
  const { ready } = vatReadiness({ rows, position: vatPosition(rows), transactionsAwaitingReview: 0, periodLocked: false });
  assert.equal(ready, false);
});

test("an empty period is not a ready nil return", () => {
  // Nothing posted is not the same as nothing owed.
  const { ready, checks } = vatReadiness({
    rows: [],
    position: vatPosition([]),
    transactionsAwaitingReview: 0,
    periodLocked: false,
  });
  assert.equal(ready, false);
  assert.ok(checks.some((check) => /No VAT has been posted/.test(check.label)));
});

test("a clean period is ready", () => {
  const rows = [row({ direction: "output", vatAmount: 750 })];
  const { ready } = vatReadiness({ rows, position: vatPosition(rows), transactionsAwaitingReview: 0, periodLocked: false });
  assert.equal(ready, true);
});

// ── The rule that separates the two VAT figures ─────────────────────────────

test("VAT is what was posted, never a rate applied to an amount", () => {
  // The report must show a wrong entry as it was posted, not a corrected
  // version. Multiplying by the rate anywhere in the summary would do the
  // latter and hide the error.
  const summary = sql.slice(sql.indexOf("function public.accounting_vat_summary"), sql.indexOf("function public.accounting_vat_register"));
  assert.doesNotMatch(summary, /\brate\s*[*/]/);
  assert.doesNotMatch(summary, /15\s*\/\s*115/);
  assert.match(summary, /p\.account_id = tc\.control_account_id/);
});

test("no VAT figure is derived from bank transactions", () => {
  // The rule is about AMOUNTS, not about the table being off-limits. VAT
  // figures come from postings; the only permitted use of the transactions
  // table here is counting what is still unreviewed, which is a readiness
  // signal and contributes to no monetary total.
  const summaryFn = sql.slice(
    sql.indexOf("function public.accounting_vat_summary"),
    sql.indexOf("function public.accounting_vat_register"),
  );
  assert.doesNotMatch(summaryFn, /accounting_transactions/);
  assert.match(summaryFn, /from public\.accounting_tax_codes/);
  assert.match(summaryFn, /join public\.accounting_postings/);

  const registerFn = sql.slice(
    sql.indexOf("function public.accounting_vat_register"),
    sql.indexOf("function public.accounting_seed_tax_codes"),
  );
  assert.doesNotMatch(registerFn, /accounting_transactions/);

  // In the server module, every reference sits inside the review counter.
  // Comments stripped first: the module's own doc comment names the table in
  // order to explain the exception, and counting prose would fail on the
  // explanation rather than on the code.
  const vatServerCode = vatServer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const references = vatServerCode.split("\n").filter((line) => /accounting_transactions/.test(line));
  assert.equal(references.length, 1, "only the review counter may reference the transactions table");
  const counter = vatServer.slice(vatServer.indexOf("countTransactionsAwaitingReview"));
  assert.match(counter, /count: "exact", head: true/, "it must count rows, never read amounts");
  assert.doesNotMatch(counter, /debit_amount|credit_amount/);
});

test("the statement estimate is preserved and named, not merged", () => {
  // §45: existing functionality is not removed. The estimate moved to its own
  // route and the ledger page links to it by name so the two cannot be confused.
  assert.match(workspace, /estimated from bank statements/);
  assert.match(workspace, /neither is a substitute for the other/);
});

test("legacy treatments are a suggestion, never applied", () => {
  assert.match(sql, /suggested_for_treatment text/);
  // No UPDATE anywhere that stamps a tax code onto existing rows.
  assert.doesNotMatch(sql, /update public\.accounting_postings[\s\S]{0,200}tax_code_id/);
  assert.doesNotMatch(sql, /update public\.accounting_journal_lines[\s\S]{0,200}tax_code_id/);
});

// ── Schema rules ────────────────────────────────────────────────────────────

test("a locked VAT period blocks only VAT-bearing journals", () => {
  // Blocking every journal would stop ordinary bookkeeping in a filed period.
  const post = sql.slice(sql.indexOf("function public.accounting_post_journal"));
  assert.match(post, /blocking_vat_period/);
  assert.match(post, /l\.tax_code_id is not null/);
  assert.match(post, /a VAT-bearing journal cannot be posted into a filed period/);
});

test("a code that arises no VAT may not carry a rate", () => {
  assert.match(sql, /accounting_tax_codes_none_has_no_rate\s+check \(direction <> 'none' or rate = 0\)/);
});

test("tax codes are entity-scoped and their control account cannot cross entities", () => {
  assert.match(
    sql,
    /accounting_tax_codes_control_same_entity[\s\S]{0,160}foreign key \(control_account_id, company_id\)[\s\S]{0,120}references public\.accounting_accounts \(id, company_id\)/,
  );
});

test("a new entity is seeded with its chart and tax codes", () => {
  // Found while testing: 035 and 040 seed only companies that existed when the
  // migration ran, so a company created later had neither.
  assert.match(sql, /create trigger accounting_seed_company\s+after insert on public\.companies/);
  assert.match(sql, /accounting_seed_chart_of_accounts/);
  assert.match(sql, /accounting_seed_tax_codes/);
});

test("the migration is non-destructive", () => {
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /truncate/i);
  assert.doesNotMatch(sql, /delete from/i);
  for (const drop of sql.match(/drop (policy|constraint|trigger)[^;]*/gi) ?? []) {
    assert.match(drop, /if exists/i);
  }
});

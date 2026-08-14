import test from "node:test";
import assert from "node:assert/strict";
import { readCoaImportRow, summariseCoaOutcomes, validateCoaImportRows, type CoaImportRow } from "../../lib/accounting/coa-import.ts";
import type { LedgerAccount } from "../../lib/accounting/chart.ts";

const account = (over: Partial<LedgerAccount> = {}): LedgerAccount => ({
  id: "acc-1",
  companyId: "c1",
  code: "1000",
  name: "Cash at Bank",
  accountType: "asset",
  normalBalance: "debit",
  parentId: null,
  isActive: true,
  isSystem: false,
  vatDefault: "out_of_scope",
  description: null,
  ...over,
});

const row = (over: Partial<CoaImportRow> = {}): CoaImportRow => ({
  rowNumber: 2,
  code: "2000",
  name: "New Account",
  accountType: "expense",
  normalBalance: "debit",
  parentCode: null,
  vatDefault: null,
  description: null,
  ...over,
});

// ── Reading a raw CSV row ────────────────────────────────────────────────────

test("readCoaImportRow accepts either the canonical or the friendly header name", () => {
  const parsed = readCoaImportRow(2, { account_code: "1000", account_name: "Cash", type: "asset", balance: "debit" });
  assert.equal(parsed.code, "1000");
  assert.equal(parsed.name, "Cash");
  assert.equal(parsed.accountType, "asset");
  assert.equal(parsed.normalBalance, "debit");
});

test("readCoaImportRow turns blank optional cells into null, not empty strings", () => {
  const parsed = readCoaImportRow(2, { code: "1000", name: "Cash", account_type: "asset", normal_balance: "debit", parent_code: "  " });
  assert.equal(parsed.parentCode, null);
});

// ── Classification ────────────────────────────────────────────────────────────

test("a code with no existing match is new", () => {
  const [outcome] = validateCoaImportRows([row()], []);
  assert.equal(outcome.status, "new");
});

test("a code matching an existing account with no field differences is unchanged", () => {
  const existing = account({ code: "2000", name: "New Account", accountType: "expense", normalBalance: "debit", vatDefault: null });
  const [outcome] = validateCoaImportRows([row()], [existing]);
  assert.equal(outcome.status, "unchanged");
});

test("a code matching an existing account with a different name is updated, and says which fields changed", () => {
  const existing = account({ code: "2000", name: "Old Name", accountType: "expense", normalBalance: "debit", vatDefault: null });
  const [outcome] = validateCoaImportRows([row({ name: "New Name" })], [existing]);
  assert.equal(outcome.status, "updated");
  if (outcome.status === "updated") assert.deepEqual(outcome.changedFields, ["name"]);
});

test("matching is case-insensitive on the code", () => {
  const existing = account({ code: "2000", name: "New Account", accountType: "expense", normalBalance: "debit", vatDefault: null });
  const [outcome] = validateCoaImportRows([row({ code: "2000" })], [existing]);
  assert.notEqual(outcome.status, "new");
});

// ── Refusals ──────────────────────────────────────────────────────────────────

test("a blank code or name is an error", () => {
  assert.equal(validateCoaImportRows([row({ code: "" })], [])[0].status, "error");
  assert.equal(validateCoaImportRows([row({ name: "" })], [])[0].status, "error");
});

test("an unrecognised account type or normal balance is an error", () => {
  assert.equal(validateCoaImportRows([row({ accountType: "nonsense" })], [])[0].status, "error");
  assert.equal(validateCoaImportRows([row({ normalBalance: "sideways" })], [])[0].status, "error");
});

test("a duplicate code within the same file is an error on the later row, naming the earlier one", () => {
  const outcomes = validateCoaImportRows([row({ rowNumber: 2, code: "3000" }), row({ rowNumber: 5, code: "3000" })], []);
  assert.equal(outcomes[0].status, "new");
  assert.equal(outcomes[1].status, "error");
  if (outcomes[1].status === "error") assert.match(outcomes[1].message, /row 2/);
});

test("changing an existing account's type or normal balance via import is refused", () => {
  const existing = account({ code: "2000", accountType: "expense", normalBalance: "debit" });
  const typeChange = validateCoaImportRows([row({ accountType: "income" })], [existing])[0];
  assert.equal(typeChange.status, "error");
  const balanceChange = validateCoaImportRows([row({ normalBalance: "credit" })], [existing])[0];
  assert.equal(balanceChange.status, "error");
});

test("a parent code must already exist in the entity's chart, not merely elsewhere in the file", () => {
  const outcomes = validateCoaImportRows(
    [row({ rowNumber: 2, code: "3000", parentCode: "3100" }), row({ rowNumber: 3, code: "3100" })],
    [],
  );
  assert.equal(outcomes[0].status, "error");
});

test("a parent code that already exists in the chart resolves fine", () => {
  const existing = account({ code: "3100", name: "Parent" });
  const [outcome] = validateCoaImportRows([row({ parentCode: "3100" })], [existing]);
  assert.equal(outcome.status, "new");
});

test("an account cannot name itself as its own parent", () => {
  const [outcome] = validateCoaImportRows([row({ code: "3000", parentCode: "3000" })], []);
  assert.equal(outcome.status, "error");
});

// ── Summary ───────────────────────────────────────────────────────────────────

test("summariseCoaOutcomes counts each status independently", () => {
  const outcomes = validateCoaImportRows(
    [row({ rowNumber: 2, code: "1" }), row({ rowNumber: 3, code: "" }), row({ rowNumber: 4, code: "1" })],
    [],
  );
  const summary = summariseCoaOutcomes(outcomes);
  assert.equal(summary.total, 3);
  assert.equal(summary.newCount, 1);
  assert.equal(summary.errorCount, 2); // blank code, and the duplicate of row 2
});

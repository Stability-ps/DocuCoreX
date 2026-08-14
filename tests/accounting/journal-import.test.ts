import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  groupJournalImportRows,
  readJournalImportRow,
  summariseJournalOutcomes,
  validateJournalImportRows,
  type JournalImportContext,
  type JournalImportRow,
} from "../../lib/accounting/journal-import.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migration = readFileSync(join(root, "supabase/migrations/045_accounting_journal_import.sql"), "utf8");
const sql = migration.replace(/--[^\n]*/g, "");

const ctx = (over: Partial<JournalImportContext> = {}): JournalImportContext => ({
  accountCodes: new Set(["1000", "6100"]),
  taxCodes: new Set(),
  customerNames: new Set(),
  supplierNames: new Set(),
  alreadyImportedReferences: new Set(),
  ...over,
});

const row = (over: Partial<JournalImportRow> = {}): JournalImportRow => ({
  rowNumber: 2,
  reference: "OB-001",
  journalDate: "2026-01-01",
  description: null,
  dueDate: null,
  journalType: null,
  accountCode: "1000",
  debit: 100,
  credit: 0,
  taxCode: null,
  customerName: null,
  supplierName: null,
  ...over,
});

// ── Reading a raw CSV row ────────────────────────────────────────────────────

test("readJournalImportRow parses debit/credit, defaulting an unparsable amount to zero", () => {
  const parsed = readJournalImportRow(2, { reference: "R1", journal_date: "2026-01-01", account_code: "1000", debit: "abc", credit: "50.5" });
  assert.equal(parsed.debit, 0);
  assert.equal(parsed.credit, 50.5);
});

// ── Grouping ──────────────────────────────────────────────────────────────────

test("rows sharing a reference become one group, in file order", () => {
  const groups = groupJournalImportRows([
    row({ rowNumber: 2, reference: "A" }),
    row({ rowNumber: 3, reference: "B" }),
    row({ rowNumber: 4, reference: "A" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].reference, "A");
  assert.deepEqual(groups[0].rowNumbers, [2, 4]);
});

test("grouping is case- and whitespace-insensitive on the reference", () => {
  const groups = groupJournalImportRows([row({ reference: " ob-1 " }), row({ reference: "OB-1" })]);
  assert.equal(groups.length, 1);
});

// ── The one-bad-line-rejects-the-whole-journal rule ─────────────────────────

test("a balanced two-line journal with known accounts is valid", () => {
  const [outcome] = validateJournalImportRows(
    [row({ rowNumber: 2, accountCode: "1000", debit: 100, credit: 0 }), row({ rowNumber: 3, accountCode: "6100", debit: 0, credit: 100 })],
    ctx(),
  );
  assert.equal(outcome.status, "valid");
});

test("one unknown account code in a multi-line journal rejects every row in that journal, not just the bad one", () => {
  const rows = [
    row({ rowNumber: 2, accountCode: "1000", debit: 100, credit: 0 }),
    row({ rowNumber: 3, accountCode: "9999", debit: 0, credit: 50 }), // unknown
    row({ rowNumber: 4, accountCode: "6100", debit: 0, credit: 50 }),
  ];
  const [outcome] = validateJournalImportRows(rows, ctx());
  assert.equal(outcome.status, "error");
  if (outcome.status === "error") {
    assert.deepEqual(outcome.rowNumbers, [2, 3, 4]); // all three, not just row 3
    assert.match(outcome.messages.join(" "), /9999.*does not exist/);
  }
});

test("other journals in the same batch are unaffected by one journal's rejection", () => {
  const rows = [
    row({ rowNumber: 2, reference: "BAD", accountCode: "9999", debit: 100, credit: 0 }),
    row({ rowNumber: 3, reference: "GOOD", accountCode: "1000", debit: 50, credit: 0 }),
    row({ rowNumber: 4, reference: "GOOD", accountCode: "6100", debit: 0, credit: 50 }),
  ];
  const outcomes = validateJournalImportRows(rows, ctx());
  const summary = summariseJournalOutcomes(outcomes);
  assert.equal(summary.totalGroups, 2);
  assert.equal(summary.validGroups, 1);
  assert.equal(summary.rejectedGroups, 1);
});

test("an unbalanced journal is rejected — the same rule accounting_post_journal itself enforces", () => {
  const rows = [row({ rowNumber: 2, accountCode: "1000", debit: 100, credit: 0 }), row({ rowNumber: 3, accountCode: "6100", debit: 0, credit: 99 })];
  const [outcome] = validateJournalImportRows(rows, ctx());
  assert.equal(outcome.status, "error");
  if (outcome.status === "error") assert.match(outcome.messages.join(" "), /does not balance/);
});

test("a missing reference is its own error, one row at a time (nothing to group it with)", () => {
  const outcomes = validateJournalImportRows([row({ reference: "" })], ctx());
  assert.equal(outcomes[0].status, "error");
});

// ── Idempotency signal ────────────────────────────────────────────────────────

test("a reference already imported for this entity is flagged, not silently re-posted", () => {
  const rows = [row({ rowNumber: 2, reference: "OB-047", accountCode: "1000", debit: 100, credit: 0 }), row({ rowNumber: 3, reference: "OB-047", accountCode: "6100", debit: 0, credit: 100 })];
  const [outcome] = validateJournalImportRows(rows, ctx({ alreadyImportedReferences: new Set(["ob-047"]) }));
  assert.equal(outcome.status, "error");
  if (outcome.status === "error") assert.match(outcome.messages.join(" "), /already been imported/);
});

// ── Journal type ──────────────────────────────────────────────────────────────

test("a blank journal_type defaults to general", () => {
  const rows = [row({ rowNumber: 2, journalType: null, accountCode: "1000", debit: 100, credit: 0 }), row({ rowNumber: 3, journalType: null, accountCode: "6100", debit: 0, credit: 100 })];
  const [outcome] = validateJournalImportRows(rows, ctx());
  assert.equal(outcome.status, "valid");
  if (outcome.status === "valid") assert.equal(outcome.journalType, "general");
});

test("an unrecognised journal_type is rejected", () => {
  const [outcome] = validateJournalImportRows([row({ journalType: "not_a_type" })], ctx());
  assert.equal(outcome.status, "error");
});

test("inconsistent journal_date within one journal group is rejected", () => {
  const rows = [row({ rowNumber: 2, journalDate: "2026-01-01" }), row({ rowNumber: 3, journalDate: "2026-01-02" })];
  const [outcome] = validateJournalImportRows(rows, ctx());
  assert.equal(outcome.status, "error");
  if (outcome.status === "error") assert.match(outcome.messages.join(" "), /disagree on journal_date/);
});

// ── The migration itself ─────────────────────────────────────────────────────

test("two imported journals cannot share a reference for one entity — the DB-enforced backstop", () => {
  assert.match(sql, /accounting_journals_one_import_per_reference/);
  assert.match(sql, /where import_batch_id is not null and reference is not null/);
});

test("a manually created journal (no import batch) is not constrained by the uniqueness index", () => {
  const indexDef = sql.slice(sql.indexOf("accounting_journals_one_import_per_reference"));
  assert.match(indexDef, /import_batch_id is not null/);
});

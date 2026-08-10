import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISIBLE_COLUMNS,
  TRANSACTION_COLUMNS,
  normalizeVisibleColumns,
  type TransactionColumnId,
} from "../../lib/accounting/transaction-columns.ts";

const LOCKED = TRANSACTION_COLUMNS.filter((column) => column.locked).map((column) => column.id);

test("no stored preference yields the previous fixed layout", () => {
  // An accountant who never opens the picker must see exactly what they saw
  // before columns became configurable.
  assert.deepEqual(normalizeVisibleColumns(null), DEFAULT_VISIBLE_COLUMNS);
  assert.deepEqual(normalizeVisibleColumns(undefined), DEFAULT_VISIBLE_COLUMNS);
});

test("locked columns cannot be hidden, however the preference arrives", () => {
  // Directly, via an empty array, and via a value that never contained them.
  for (const stored of [[], ["vat"], ["category", "status"]]) {
    const visible = normalizeVisibleColumns(stored);
    for (const locked of LOCKED) {
      assert.ok(visible.includes(locked), `${locked} must survive ${JSON.stringify(stored)}`);
    }
  }
});

test("a row is never left unidentifiable", () => {
  // The point of locking: date, description and both money columns together
  // are the minimum that identifies a statement line.
  const visible = normalizeVisibleColumns([]);
  for (const required of ["date", "description", "credit", "debit"]) {
    assert.ok(visible.includes(required as TransactionColumnId), `${required} must always be shown`);
  }
});

test("unknown ids are dropped rather than trusted", () => {
  // A preference written by an older or newer build must not resurrect a
  // column that has no renderer — that would throw at render time.
  const visible = normalizeVisibleColumns(["date", "description", "credit", "debit", "not_a_column", "balance"]);
  assert.ok(!visible.includes("not_a_column" as TransactionColumnId));
  assert.ok(visible.includes("balance"));
});

test("malformed storage degrades to the default instead of throwing", () => {
  for (const stored of ["nonsense", 42, {}, [1, 2, 3], [null]]) {
    const visible = normalizeVisibleColumns(stored);
    for (const locked of LOCKED) assert.ok(visible.includes(locked));
  }
  // A non-array is not a partial selection — it is no selection.
  assert.deepEqual(normalizeVisibleColumns("nonsense"), DEFAULT_VISIBLE_COLUMNS);
});

test("canonical column order is preserved, not storage order", () => {
  // Reordering columns would be a separate, deliberate feature; a stored value
  // in a different order must not silently become one.
  const visible = normalizeVisibleColumns(["status", "date", "category", "description", "credit", "debit"]);
  const canonical = TRANSACTION_COLUMNS.map((column) => column.id).filter((id) => visible.includes(id));
  assert.deepEqual(visible, canonical);
});

test("an optional column genuinely turns off", () => {
  // The counterpart to the locking tests: hiding must actually work, or the
  // picker is decorative.
  const visible = normalizeVisibleColumns(DEFAULT_VISIBLE_COLUMNS.filter((id) => id !== "balance"));
  assert.ok(!visible.includes("balance"));
  assert.ok(visible.includes("date"));
});

test("sourcePage is available but off by default", () => {
  // It is new in this change; defaulting it on would alter the table for
  // everyone without being asked.
  assert.ok(TRANSACTION_COLUMNS.some((column) => column.id === "sourcePage"));
  assert.ok(!DEFAULT_VISIBLE_COLUMNS.includes("sourcePage"));
  assert.ok(normalizeVisibleColumns(["sourcePage"]).includes("sourcePage"));
});

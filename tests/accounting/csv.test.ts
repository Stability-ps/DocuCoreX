import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvWithHeader } from "../../lib/accounting/csv.ts";

test("splits plain comma-separated rows", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("a quoted field may contain a comma", () => {
  assert.deepEqual(parseCsv('a,"b, still b",c'), [["a", "b, still b", "c"]]);
});

test("a doubled quote inside a quoted field is a literal quote", () => {
  assert.deepEqual(parseCsv('"She said ""hi""",b'), [['She said "hi"', "b"]]);
});

test("a quoted field may contain a newline", () => {
  assert.deepEqual(parseCsv('"line one\nline two",b'), [["line one\nline two", "b"]]);
});

test("handles both \\n and \\r\\n line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("a trailing newline does not produce a phantom final row", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("a file with no trailing newline still reads its last row", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

// ── Row numbering must survive blank lines ──────────────────────────────────

test("a blank line in the middle does not shift later row numbers", () => {
  const { rows } = parseCsvWithHeader("code,name\n1000,Cash\n\n2000,Loans\n");
  assert.deepEqual(
    rows.map((r) => r.rowNumber),
    [2, 4], // row 3 was the blank line, correctly skipped rather than renumbered away
  );
  assert.equal(rows[1].cells.code, "2000");
});

test("header cells are trimmed, lower-cased and space-to-underscore normalised", () => {
  const { headers } = parseCsvWithHeader("Account Code, Account Name\n1000,Cash");
  assert.deepEqual(headers, ["account_code", "account_name"]);
});

test("an empty file has no headers and no rows", () => {
  assert.deepEqual(parseCsvWithHeader(""), { headers: [], rows: [] });
});

test("a header-only file has no rows", () => {
  const { rows } = parseCsvWithHeader("code,name\n");
  assert.deepEqual(rows, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { neutraliseSpreadsheetFormula, toCsv } from "../../lib/accounting/ledger.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("text that a spreadsheet would run as a formula opens as text", () => {
  for (const hostile of ['=HYPERLINK("https://attacker.example","x")', "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1+1", "\r=1+1"]) {
    assert.equal(neutraliseSpreadsheetFormula(hostile), `'${hostile}`, hostile);
  }
});

test("numbers and ordinary text are left exactly as they are", () => {
  for (const plain of ["-12.50", "+5", "1,234.56", "-1,234.56", ".5", "0", "Woolworths Sandton", "Payment - rent", "", "R-100"]) {
    assert.equal(neutraliseSpreadsheetFormula(plain), plain, plain);
  }
});

test("toCsv neutralises hostile text cells and keeps numbers numeric", () => {
  const csv = toCsv(["Description", "Amount"], [["=1+1", -12.5], ["Rent", 100]]);
  assert.equal(csv, `"Description","Amount"\r\n"'=1+1",-12.5\r\n"Rent",100`);
});

test("the accounting export's CSV cells go through the same guard", () => {
  const src = readFileSync(join(root, "lib/accounting/export.ts"), "utf8");
  assert.match(src, /!cell\.num \? neutraliseSpreadsheetFormula\(String\(cell\.v\)\)/);
});

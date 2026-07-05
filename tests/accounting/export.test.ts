import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Guards for the Accounting Intelligence export fixes so they cannot silently
// regress. (These read source text; the full XLSX is validated by pnpm build.)

test("no hardcoded ALLIANZ company name in the export path", () => {
  for (const file of [
    "lib/accounting/export.ts",
    "app/api/accounting/fnb/export/[runId]/route.ts",
    "lib/accounting/server.ts",
  ]) {
    assert.doesNotMatch(read(file), /ALLIANZ/i, `${file} must not hardcode ALLIANZ`);
  }
});

test("python worker derives the workbook title from extracted metadata, not a hardcode", () => {
  const py = read("workers/accounting_worker/main.py");
  assert.doesNotMatch(py, /company_name\s*=\s*["']ALLIANZ/i, "must not assign a hardcoded ALLIANZ company name");
  assert.match(py, /company_name\s*=\s*\(metadata\.get\("company_name"\)/, "workbook must use the extracted company name");
});

test("company name resolution falls back statement -> workspace -> generic", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /export function resolveCompanyName/, "resolveCompanyName must exist");
  assert.match(src, /"Bank Statement Accounting Pack"/, "generic fallback title must exist");
});

test("VAT schedule includes output, input and net VAT columns", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /B\("Output VAT"\)/);
  assert.match(src, /B\("Input VAT"\)/);
  assert.match(src, /B\("Net VAT"\)/);
  assert.match(src, /B\("Claim Status"\)/);
});

test("workbook styles apply a red-negative number format", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /\[Red\]/, "styles.xml must use a [Red] negative number format");
});

test("full pack includes every required accounting section", () => {
  const src = read("lib/accounting/export.ts");
  const required = [
    "transactions",
    "review-items",
    "vat",
    "general-ledger",
    "trial-balance",
    "bank-reconciliation",
    "profit-loss",
    "balance-sheet",
    "cash-flow",
    "financial-statements",
    "tax-vat",
    "ai-intelligence",
    "forecasting",
    "audit-tools",
    "assumptions",
  ];
  for (const id of required) {
    assert.match(src, new RegExp(`id:\\s*"${id}"`), `export must build the "${id}" section`);
  }
});

test("export route offers single-section CSV and grouped/full XLSX packs", () => {
  const route = read("app/api/accounting/fnb/export/[runId]/route.ts");
  assert.match(route, /CSV_SECTIONS/, "single-section CSV downloads must exist");
  assert.match(route, /XLSX_PACKS/, "grouped/full XLSX packs must exist");
  assert.match(route, /"financial-statements":/, "financial statements pack must exist");
  assert.match(route, /"audit-pack":/, "audit pack must exist");
});

test("accounting UI has a sticky action bar and an export selector modal", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /sticky top-2 z-40/, "selected-run action bar must be sticky");
  assert.match(ui, /function ExportOptionsModal/, "export selector modal must exist");
  assert.match(ui, /Full Accounting Pack/, "modal must offer the full pack");
});

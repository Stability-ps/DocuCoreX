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

test("VAT schedule includes all required columns", () => {
  const src = read("lib/accounting/export.ts");
  for (const col of ["Output VAT", "Input VAT", "Net VAT", "Claim Status", "VAT Treatment", "Document Status", "Review Reason", "Confidence"]) {
    assert.match(src, new RegExp(`HDR\\("${col}"\\)`), `VAT schedule must have a "${col}" column`);
  }
});

test("one canonical statement metadata object feeds every sheet", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /export function buildStatementMetadata/, "canonical metadata builder must exist");
  assert.match(src, /export type StatementMetadata/);
});

test("reconciliation is validated and reports are watermarked when unbalanced", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /reconciliationDifference/);
  assert.match(src, /unreliableBanner/, "reports must carry an unreliable watermark");
  assert.match(src, /REVIEW REQUIRED/, "cover must flag review required");
});

test("workbook has professional formatting (freeze, filter, auto-fit, colour styles)", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /state="frozen"/, "freeze panes");
  assert.match(src, /autoFilter ref=/, "auto filter");
  assert.match(src, /customWidth="1"/, "auto-fit column widths");
  assert.match(src, /numFmtId="164"/, "money format");
  assert.match(src, /FFDCFCE7/, "green fill");
  assert.match(src, /FFFFEDD5/, "orange (review) fill");
});

test("workbook styles apply a red-negative number format", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /\[Red\]/, "styles.xml must use a [Red] negative number format");
});

test("full pack includes every core accounting section", () => {
  const src = read("lib/accounting/export.ts");
  const required = [
    "transactions",
    "review-queue",
    "vat",
    "general-ledger",
    "trial-balance",
    "bank-reconciliation",
    "profit-loss",
    "balance-sheet",
    "cash-flow",
    "ai-intelligence",
    "exception-report",
    "assumptions",
    "data-quality",
    "extraction-log",
  ];
  for (const id of required) {
    assert.match(src, new RegExp(`id:\\s*"${id}"`), `export must build the "${id}" section`);
  }
});

test("removed/merged sheets are no longer generated", () => {
  const src = read("lib/accounting/export.ts");
  for (const gone of ["chart-of-accounts", "vat201", "ai-categorisation", "lead-schedules", "tax-vat", "reconciliation-issues", "audit-tools"]) {
    assert.doesNotMatch(src, new RegExp(`id:\\s*"${gone}"`), `"${gone}" sheet must be removed/merged`);
  }
});

test("data quality report is a hard extraction gate", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /Extraction status: COMPLETE/);
  assert.match(src, /Extraction status: REVIEW REQUIRED/);
  assert.match(src, /const extractionOk = meta\.reconciled/);
});

test("export route serves the full pack and every individual export", () => {
  const route = read("app/api/accounting/fnb/export/[runId]/route.ts");
  assert.match(route, /EXPORT_MENU/, "route uses the shared export menu");
  assert.match(route, /FULL_PACK_SECTIONS/, "route uses the shared full pack");
  assert.match(route, /SECTION_BY_KEY/, "route resolves each export key to a section");
});

test("accounting UI has a sticky action bar and an export selector modal", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /sticky top-2 z-40/, "selected-run action bar must be sticky");
  assert.match(ui, /function ExportOptionsModal/, "export selector modal must exist");
  assert.match(ui, /Full Accounting Pack/, "modal must offer the full pack");
});

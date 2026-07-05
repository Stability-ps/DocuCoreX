import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Guards for the Accounting Intelligence export fixes so they cannot silently
// regress. (These read source text; the full XLSX is validated by pnpm build.)

test("export menu includes the Transaction Insights Report and it is buildable", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /label: "Transaction Insights Report", section: "transaction-insights"/, "export menu must offer the insights report");
  assert.match(src, /id: "transaction-insights"/, "the insights section must be built");
  // Report content — no AI/internal wording, professional insight groupings.
  assert.match(src, /Duplicate payment groups/);
  assert.match(src, /Unusual transactions/);
  assert.match(src, /Related-party & director activity/);
  assert.match(src, /Large transactions/);
  assert.match(src, /Unresolved review items/);
  assert.match(src, /VAT review items/);
});

test("the shared document viewer uses an in-app fullscreen overlay, not browser fullscreen", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.doesNotMatch(viewer, /requestFullscreen/, "must not use browser requestFullscreen (it froze the app)");
  assert.match(viewer, /role="dialog"/, "fullscreen must be an in-app overlay");
  assert.match(viewer, /setFullscreen\(false\)/, "overlay must have a close action");
  assert.match(viewer, /event\.key === "Escape"/, "ESC must close the overlay");
});

test("the shared document viewer rotate keeps the page centred", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /rotate\(\$\{rotate\}deg\)/, "rotation transform must be applied");
  assert.match(viewer, /transformOrigin: "center center"/, "rotation must be centred, not pushed out");
  assert.match(viewer, /setRotate\(\(r\) => \(r \+ 90\) % 360\)/, "rotate must cycle 0/90/180/270");
});

test("no user-facing AI wording in the accounting UI", () => {
  for (const file of ["components/accounting/statement-workspace.tsx", "components/accounting/accounting-intelligence.tsx"]) {
    const src = read(file);
    for (const banned of ['"AI Intelligence"', '"AI Transaction Intelligence"', '"AI Accountant Notes"', '"AI Notes"', '"OpenAI"', "extraction engine"]) {
      assert.ok(!src.includes(banned), `${file} must not show ${banned}`);
    }
  }
  assert.match(read("components/accounting/accounting-intelligence.tsx"), /label: "Transaction Insights"/, "AI Intelligence tab must be renamed to Transaction Insights");
});

test("one shared DocumentViewer is the standard viewer across the platform", () => {
  // The shared component exists.
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /export function DocumentViewer/, "shared DocumentViewer must exist");
  assert.doesNotMatch(viewer, /requestFullscreen/, "shared viewer must not use browser fullscreen");
  assert.match(viewer, /role="dialog"/, "shared viewer uses an in-app fullscreen overlay");

  // The Statement Review Workspace uses the shared viewer, not its own.
  const workspace = read("components/accounting/statement-workspace.tsx");
  assert.match(workspace, /import \{ DocumentViewer \} from "@\/components\/document-viewer"/, "workspace must import the shared viewer");
  assert.match(workspace, /<DocumentViewer /, "workspace must render the shared viewer");
  assert.doesNotMatch(workspace, /function PdfViewer\(/, "workspace must not define its own viewer");

  // The Documents preview uses the shared viewer, not a bare iframe.
  const docs = read("components/documents/document-detail-panel.tsx");
  assert.match(docs, /import \{ DocumentViewer/, "documents preview must import the shared viewer");
  assert.match(docs, /<DocumentViewer /, "documents preview must render the shared viewer");
  assert.doesNotMatch(docs, /<iframe title=\{`Preview of/, "documents preview must not use a bare iframe");
});

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

test("VAT working paper includes all required columns (no engine columns)", () => {
  const src = read("lib/accounting/export.ts");
  for (const col of ["Output VAT", "Input VAT", "Net VAT", "Claim Status", "VAT Code", "VAT %", "VAT201 Box", "Category"]) {
    assert.match(src, new RegExp(`HDR\\("${col}"\\)`), `VAT working paper must have a "${col}" column`);
  }
  // Engine/AI columns must be gone.
  for (const gone of ["Confidence", "Source", "VAT Treatment"]) {
    assert.doesNotMatch(src, new RegExp(`HDR\\("${gone}"\\)`), `"${gone}" column must be removed`);
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
    "cover",
    "summary",
    "transactions",
    "review-queue",
    "vat",
    "general-ledger",
    "trial-balance",
    "profit-loss",
    "balance-sheet",
    "cash-flow",
    "bank-reconciliation",
    "assumptions",
  ];
  for (const id of required) {
    assert.match(src, new RegExp(`id:\\s*"${id}"`), `export must build the "${id}" section`);
  }
});

test("removed/merged sheets are no longer generated", () => {
  const src = read("lib/accounting/export.ts");
  for (const gone of ["chart-of-accounts", "vat201", "ai-categorisation", "lead-schedules", "tax-vat", "reconciliation-issues", "audit-tools", "ai-intelligence", "exception-report", "data-quality", "extraction-log", "financial-statements", "forecasting", "review-items"]) {
    assert.doesNotMatch(src, new RegExp(`id:\\s*"${gone}"`), `"${gone}" sheet must be removed/merged`);
  }
});

test("extraction is a hard gate — statements are watermarked when unreconciled", () => {
  const src = read("lib/accounting/export.ts");
  assert.match(src, /REVIEW REQUIRED/);
  assert.match(src, /unreliableBanner/, "reports must carry a review-required watermark");
  assert.match(src, /meta\.reconciled/);
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

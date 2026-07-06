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

test("statement processing starts automatically after upload with duplicate protection", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  // Upload auto-triggers processing (no manual click needed).
  assert.match(ui, /void autoProcess\(run\.id, item\.id\)/, "upload must auto-start processing");
  assert.match(ui, /async function autoProcess/, "autoProcess must exist");
  // Duplicate-job guard on the client (a run is only auto-processed once).
  assert.match(ui, /autoProcessedRef\.current\.has\(runId\)/, "client must guard against duplicate auto-processing");
  // Manual Process/Re-process kept for reruns.
  assert.match(ui, /async function processSelectedRuns/, "manual Process Selected kept for reruns");

  // Server-side duplicate protection: never start a second in-flight job.
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /detail\.run\.status === "processing" && !body\.reprocess/, "server must reject a duplicate in-flight job");
  assert.match(route, /reprocess\?: boolean/, "process route accepts a reprocess flag");

  // Re-process from the workspace forces a rerun.
  const ws = read("components/accounting/statement-workspace.tsx");
  assert.match(ws, /reprocess: true/, "Re-process must force a rerun");
});

test("preview routes are framable same-origin (not blocked by X-Frame-Options)", () => {
  const cfg = read("next.config.ts");
  // Global DENY must no longer apply to every path (that blocked the preview iframe).
  assert.doesNotMatch(cfg, /source: "\/\(\.\*\)", headers: securityHeaders/, "must not apply X-Frame-Options: DENY to all routes");
  // X-Frame-Options: DENY is scoped to page routes only (excludes /api).
  assert.match(cfg, /source: "\/\(\(\?!api\/\)\.\*\)"/, "DENY must target page routes, excluding /api");
  // Preview routes allow same-origin framing via CSP.
  assert.match(cfg, /frame-ancestors 'self'/, "preview routes must allow same-origin framing");
  assert.match(cfg, /api\/documents\/:id\/preview/, "documents preview route is framable");
  assert.match(cfg, /api\/accounting\/fnb\/runs\/:id\/source/, "statement source route is framable");
});

test("preview serves inline, download serves attachment (separate logic)", () => {
  // Documents: dedicated inline preview endpoint, separate attachment download.
  const preview = read("app/api/documents/[id]/preview/route.ts");
  assert.match(preview, /"content-disposition": `inline/, "preview must be Content-Disposition: inline");
  assert.doesNotMatch(preview, /"content-disposition":\s*`?attachment/, "preview endpoint header must never force a download");
  const download = read("app/api/documents/[id]/download/route.ts");
  assert.match(download, /"content-disposition": `attachment/, "download must stay attachment");

  // Accounting statement source streams inline, and only attaches on ?download=1.
  const source = read("app/api/accounting/fnb/runs/[id]/source/route.ts");
  assert.doesNotMatch(source, /NextResponse\.redirect/, "must stream same-origin, not redirect to a cross-origin signed URL");
  assert.match(source, /download \? "attachment" : "inline"/, "inline by default, attachment on ?download=1");

  // The Documents preview uses the inline preview URL for viewing and the
  // download URL only for the Download button.
  const docs = read("components/documents/document-detail-panel.tsx");
  assert.match(docs, /const previewUrl = `\/api\/documents\/\$\{documentId\}\/preview`/, "documents must build an inline preview URL");
  assert.match(docs, /previewUrl=\{previewUrl\} downloadUrl=\{downloadUrl\}/, "preview inline, download separately");
});

test("Documents preview fits width and previews inline (no auto-download)", () => {
  const preview = read("components/documents/document-preview.tsx");
  assert.match(preview, /view=FitH/, "Documents preview must default to Fit Width");
  assert.match(preview, /h-full w-full/, "the frame must fill the container width");
  assert.match(preview, /src=\{previewUrl\}|src=\{frameSrc\}/, "preview must use the inline preview URL, not the download URL");
  assert.match(preview, /href=\{downloadUrl\}/, "Download button uses the download URL");
  assert.match(preview, /transformOrigin: "center center"/, "rotate must keep the document centred");
  assert.match(preview, /const fitWidth = \(\)/, "Fit button resets to Fit Width");
  // Tall, responsive height (viewport-based) — not a short fixed height.
  assert.match(preview, /h-\[calc\(100vh-13rem\)\]/, "preview must fill the remaining viewport height");
  assert.match(preview, /min-h-\[78vh\]/, "preview must stay tall on short layouts");
  assert.doesNotMatch(preview, /min-h-\[70vh\]" /, "must not keep the short fixed height");
  // The Documents panel renders the width-fitting preview, not the shared viewer.
  const docs = read("components/documents/document-detail-panel.tsx");
  assert.match(docs, /<DocumentPreview /, "Documents must render the Fit-Width preview");
});

test("the shared document viewer separates preview and download and handles errors", () => {
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /downloadUrl\?: string/, "viewer must accept a separate download URL");
  assert.match(viewer, /const resolvedDownloadUrl = downloadUrl \?\? sourceUrl/, "download button uses downloadUrl");
  // Error handling: title, actual message, Retry, Download Original.
  assert.match(viewer, /Unable to preview document/);
  assert.match(viewer, /Download Original/);
  assert.match(viewer, /onError=\{onFrameError\}/, "frame errors must be handled, not left blank");
  assert.match(viewer, /RENDER_TIMEOUT_MS/, "a render timeout must surface an error instead of a blank viewer");
  // Dev-only diagnostics.
  assert.match(viewer, /viewer diagnostics/);
  assert.match(viewer, /renderStarted|renderCompleted|renderFailed/);
  assert.match(viewer, /process\.env\.NODE_ENV !== "production"/, "diagnostics must be development-only");
});

test("shared DocumentViewer stays intact and is used by the statement workspace", () => {
  // The shared component exists and is unchanged in behaviour.
  const viewer = read("components/document-viewer.tsx");
  assert.match(viewer, /export function DocumentViewer/, "shared DocumentViewer must exist");
  assert.doesNotMatch(viewer, /requestFullscreen/, "shared viewer must not use browser fullscreen");
  assert.match(viewer, /role="dialog"/, "shared viewer uses an in-app fullscreen overlay");

  // The Statement Review Workspace uses the shared viewer, not its own.
  const workspace = read("components/accounting/statement-workspace.tsx");
  assert.match(workspace, /import \{ DocumentViewer \} from "@\/components\/document-viewer"/, "workspace must import the shared viewer");
  assert.match(workspace, /<DocumentViewer /, "workspace must render the shared viewer");
  assert.doesNotMatch(workspace, /function PdfViewer\(/, "workspace must not define its own viewer");
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

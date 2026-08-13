import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The accounting workspace's navigation is now ROUTES, not component state.
 *
 * That trades one failure mode for another. State-driven tabs could not point
 * somewhere that does not exist; links can. A sidebar entry leading to a 404 is
 * the dead control the specification forbids, and it is invisible in a type
 * check — `href` is just a string. So the check that matters is filesystem
 * truth: every accounting link resolves to a page that exists.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const productData = readFileSync(join(root, "lib/product-data.ts"), "utf8");
const workspace = readFileSync(join(root, "components/accounting/accounting-intelligence.tsx"), "utf8");
const overview = readFileSync(join(root, "components/accounting/accounting-overview.tsx"), "utf8");
const statementWorkspace = readFileSync(join(root, "components/accounting/statement-workspace.tsx"), "utf8");

/** The accounting group's children, read from the real nav definition. */
function accountingNavHrefs(): string[] {
  const start = productData.indexOf('title: "Accounting & Financial Reporting"');
  assert.notEqual(start, -1, "the accounting nav group should exist under its new name");
  const groupEnd = productData.indexOf("},\n  { title: \"Invoices\"", start);
  const group = productData.slice(start, groupEnd === -1 ? start + 2000 : groupEnd);
  return [...group.matchAll(/href: "(\/accounting[^"]*)"/g)].map((match) => match[1]);
}

/** A Next.js App Router path is served when its directory holds a page file. */
function routeExists(href: string): boolean {
  const segment = href.replace(/^\//, "");
  return existsSync(join(root, "app", segment, "page.tsx"));
}

test("the module is named Accounting & Financial Reporting, not Accounting Intelligence", () => {
  // The rename has to reach every surface a user reads, not just the sidebar —
  // the breadcrumb inside the statement workspace and the load-failure message
  // are both places the old name survived a partial rename.
  assert.match(productData, /title: "Accounting & Financial Reporting"/);
  for (const [name, source] of [
    ["product-data", productData],
    ["accounting-intelligence", workspace],
    ["statement-workspace", statementWorkspace],
  ] as const) {
    assert.doesNotMatch(source, /Accounting Intelligence/, `${name} still shows the old module name`);
  }
});

test("every accounting sidebar link resolves to a route that exists", () => {
  const hrefs = accountingNavHrefs();
  assert.ok(hrefs.length >= 7, `expected the accounting sections to be listed, got ${hrefs.length}`);

  for (const href of hrefs) {
    assert.ok(routeExists(href), `sidebar links to ${href} but app${href}/page.tsx does not exist`);
  }
});

test("every module has a route, and every route target exists", () => {
  // ACCOUNTING_MODULE_ROUTES is what the empty states link through. A module
  // missing from it would be a TypeScript error; a route missing from disk
  // would not be, which is what this covers.
  const map = workspace.slice(
    workspace.indexOf("export const ACCOUNTING_MODULE_ROUTES"),
    workspace.indexOf("const MODULE_META"),
  );
  const targets = [...map.matchAll(/"(\/accounting\/[^"]+)"/g)].map((match) => match[1]);

  const modules = (workspace.match(/^type AccountingModule = (.+);$/m) as RegExpMatchArray)[1]
    .split("|")
    .map((entry) => entry.trim().replace(/"/g, ""));

  assert.equal(targets.length, modules.length, "every module needs exactly one route");
  for (const target of targets) {
    assert.ok(routeExists(target), `module route ${target} has no page`);
  }
});

test("the section is chosen by the route rather than by local state", () => {
  // The regression this guards: reintroducing internal module state would make
  // the routes cosmetic, and every section would silently render the same one.
  // Matched against the call, not the words: the doc comment above the
  // component explains what it used to be, and a looser pattern matches that
  // prose and passes whatever the code does.
  assert.doesNotMatch(workspace, /\[activeModule, setActiveModule\] = useState/);
  assert.doesNotMatch(workspace, /setActiveModule\(/);
  assert.match(workspace, /module = "bank-statements" \}: \{ module\?: AccountingModule \}/);
});

test("the overview states no ledger balance it cannot derive", () => {
  // The overview must not present ledger figures before a ledger exists. A
  // "Trade Receivables R0" card is not an empty state — it is a false statement
  // about a client's books. These become legitimate once postings land.
  for (const forbidden of ["Trade Receivables", "Trade Payables", "Net Profit", "VAT Payable"]) {
    assert.ok(!overview.includes(`label="${forbidden}"`), `overview must not present ${forbidden} before the ledger exists`);
  }
  // What it does show about balances is attributed to the statement, not the books.
  assert.match(overview, /Closing balance per statement/);
});

test("readiness statuses are not conveyed by colour alone", () => {
  assert.match(overview, /CheckCircle2/);
  assert.match(overview, /AlertTriangle/);
  assert.match(overview, /Passed:|Needs attention:/);
  assert.match(overview, /role="progressbar"/);
});

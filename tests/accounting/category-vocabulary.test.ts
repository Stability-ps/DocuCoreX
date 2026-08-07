import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const {
  CANONICAL_CATEGORIES,
  CATEGORY_OPTIONS,
  canonicaliseCategory,
  categoryLabel,
  categoryOptionsFor,
  isKnownCategory,
} = await import("@/lib/accounting/categories.ts");
const { ACCOUNTING_CATEGORY_OPTIONS } = await import("@/lib/accounting/review-options.ts");

// Four vocabularies had drifted apart — 46 distinct strings across the worker's
// stored categories, the professional chart, this dropdown and AI validation.
// Eleven categories the worker wrote could not be selected by a reviewer, and
// nine options here were produced by nothing.

test("TypeScript and the Python worker read the same file", () => {
  // Not a copy that has to be kept in sync — the same bytes.
  const shared = JSON.parse(read("workers/accounting_worker/engine/categories.json"));
  const ids = shared.categories.map((entry: { id: string }) => entry.id);
  assert.deepEqual(CANONICAL_CATEGORIES, ids, "the TS view is exactly the canonical list");

  const loader = read("workers/accounting_worker/engine/categories.py");
  assert.match(loader, /categories\.json/, "the Python loader reads the same file");
  const tsSource = read("lib/accounting/categories.ts");
  assert.match(tsSource, /workers\/accounting_worker\/engine\/categories\.json/, "the TS loader reads the same file");
});

test("every category a reviewer can select is one the system can store", () => {
  for (const option of CATEGORY_OPTIONS) {
    assert.ok(CANONICAL_CATEGORIES.includes(option.value), `${option.value} is storable`);
    assert.ok(option.label.length > 0, `${option.value} has a human label`);
  }
  assert.equal(CATEGORY_OPTIONS.length, CANONICAL_CATEGORIES.length);
});

test("the categories that were previously AI-only are now selectable", () => {
  // These eleven were produced by the AI/professional chart but absent from the
  // dropdown, so a reviewer could not choose or restore them.
  const previouslyUnselectable = [
    "Cash Deposits / Revenue",
    "Courier / Freight",
    "Director Loan / Drawings",
    "Meals / Groceries - Non Deductible Review",
    "Medical Expenses",
    "Operating Expenses",
    "Other Income / Review",
    "Road Tolls",
    "SARS / Tax Suspense",
    "Salaries / Drawings / Personal",
    "Telephone / Internet / Communication",
  ];
  for (const category of previouslyUnselectable) {
    assert.ok(CANONICAL_CATEGORIES.includes(category), `${category} is now selectable`);
  }
});

test("historical spellings resolve and are never offered as new choices", () => {
  const historical: Record<string, string> = {
    "Insurance Expense": "Insurance",
    "Tax / SARS Suspense": "SARS / Tax Suspense",
    "Courier / Delivery": "Courier / Freight",
    "Software Subscriptions": "Software / IT",
    "Salaries & Wages": "Salaries / Drawings / Personal",
    "Related Party / Drawings": "Director Loan / Drawings",
    "Staff Welfare / Meals / Entertainment": "Meals / Groceries - Non Deductible Review",
    "Other Operating Expenses": "Operating Expenses",
    "Uncategorised Expense": "Uncategorised",
    "Unclassified Expense": "Uncategorised",
    "Review Required": "Suspense / Review Required",
    "Revenue Review": "Other Income / Review",
  };
  for (const [old, canonical] of Object.entries(historical)) {
    assert.equal(canonicaliseCategory(old), canonical, `${old} resolves`);
    assert.ok(!CANONICAL_CATEGORIES.includes(old), `${old} is not offered as a new choice`);
  }
});

test("a row holding a historical value still renders it", () => {
  // A <select> whose value is absent from its options renders blank, which would
  // misrepresent a classified row as unclassified.
  const options = categoryOptionsFor("Insurance Expense");
  assert.equal(options[0].value, "Insurance Expense", "the stored value is present");
  assert.match(options[0].label, /Insurance/, "and is labelled recognisably");
  assert.ok(options.length === CATEGORY_OPTIONS.length + 1, "the canonical choices follow");

  const unrecognised = categoryOptionsFor("Something Nobody Defined");
  assert.equal(unrecognised[0].value, "Something Nobody Defined");
  assert.match(unrecognised[0].label, /unrecognised/, "and is flagged rather than hidden");
});

test("a canonical row is offered exactly the canonical choices", () => {
  assert.equal(categoryOptionsFor("Bank Charges").length, CATEGORY_OPTIONS.length);
});

test("an unrecognised category is reported, not guessed", () => {
  for (const unknown of ["Bank Fees", "Sundry", "", null, undefined]) {
    assert.equal(canonicaliseCategory(unknown), null, `${unknown} is not a known category`);
    assert.equal(isKnownCategory(unknown), false);
  }
  assert.equal(categoryLabel("Bank Fees"), "Bank Fees", "an unknown value is shown as it is stored");
});

test("learned rules may only store a canonical, resolved category", () => {
  const server = read("lib/accounting/server.ts");
  assert.match(server, /const learnableCategory = canonicaliseCategory\(transaction\.accountCategory\)/);
  assert.match(server, /account_category: learnableCategory,/, "the rule stores the canonical value");
  assert.match(server, /isUnresolvedAccountingCategory\(learnableCategory\)/, "unresolved is not a lesson");
});

test("the deprecated list is the canonical list, not a second copy", () => {
  assert.deepEqual(ACCOUNTING_CATEGORY_OPTIONS, CANONICAL_CATEGORIES);
});

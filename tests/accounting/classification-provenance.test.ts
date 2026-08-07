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

const { enrichTransaction } = await import("@/lib/accounting/model.ts");

// The review UI used to reconstruct a transaction's classification source from
// its confidence number: >=90 "Rule", 70-89 "Learned", below 70 "AI". On a real
// 615-row Standard Bank statement that displayed 434 unresolved rows as
// AI-classified — AI had never seen them, and could not have, because AI
// classification runs during workbook export, after these rows are written.

function transaction(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    runId: "r1",
    workspaceId: "w1",
    transactionDate: "2025-05-02",
    description: "ACC 301981485 SERVICE FEE",
    debitAmount: 574.3,
    creditAmount: null,
    runningBalance: -1000,
    bankCharge: true,
    accountCategory: "Bank Charges",
    vatTreatment: "standard",
    supportedByInvoice: false,
    notes: "",
    confidence: 97,
    classificationSource: null,
    classificationStrength: null,
    classificationConfidence: null,
    classificationReason: null,
    normalizedMerchant: null,
    reviewStatus: "needs_review",
    sourcePage: 1,
    rawText: "raw",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as never;
}

test("the recorded source is used, not the confidence number", () => {
  // A high-confidence row that was in fact unresolved must not read as "Rule".
  const unresolved = enrichTransaction(transaction({ classificationSource: "unresolved", confidence: 97 }));
  assert.equal(unresolved.source, "Unresolved");

  // A low-confidence row classified by a deterministic rule must not read as "AI".
  const deterministic = enrichTransaction(transaction({ classificationSource: "deterministic", confidence: 55 }));
  assert.equal(deterministic.source, "Rule");

  const learned = enrichTransaction(transaction({ classificationSource: "learned_rule", confidence: 55 }));
  assert.equal(learned.source, "Learned");

  const ai = enrichTransaction(transaction({ classificationSource: "ai", confidence: 95 }));
  assert.equal(ai.source, "AI");
});

test("an approved row is the reviewer's decision, whatever produced the suggestion", () => {
  const approved = enrichTransaction(transaction({ classificationSource: "ai", reviewStatus: "approved" }));
  assert.equal(approved.source, "Manual");
});

test("rows predating provenance are never claimed to be AI-classified", () => {
  // The old inference labelled anything under 70 as "AI". Without a recorded
  // source we cannot know, and Unresolved says that instead of inventing it.
  const historical = enrichTransaction(transaction({ classificationSource: null, confidence: 55 }));
  assert.equal(historical.source, "Unresolved");

  const historicalHigh = enrichTransaction(transaction({ classificationSource: null, confidence: 95 }));
  assert.equal(historicalHigh.source, "Rule");
});

test("the migration and the worker agree on the source vocabulary", () => {
  const migration = read("supabase/migrations/021_classification_provenance.sql");
  const worker = read("workers/accounting_worker/engine/classification.py");
  for (const value of ["deterministic", "learned_rule", "ai", "manual", "unresolved"]) {
    assert.ok(migration.includes(value), `migration documents ${value}`);
    assert.ok(worker.includes(`"${value}"`), `worker defines ${value}`);
  }
});

test("the original bank description is never replaced by a normalized merchant", () => {
  const enriched = enrichTransaction(
    transaction({ description: "POS PURCHASE WOOLWORTHS MENLYN 004829", normalizedMerchant: "Woolworths" }),
  );
  assert.equal(enriched.description, "POS PURCHASE WOOLWORTHS MENLYN 004829", "bank evidence is preserved");
});

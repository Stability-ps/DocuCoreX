import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { reconciliationConfidence, buildConfidenceTrio, legacyConfidence, CONFIDENCE_LABELS } =
  await import("../../lib/accounting/confidence.ts");

function validation(over: Record<string, unknown> = {}) {
  return {
    valid: true,
    requiresReview: false,
    checks: [
      { rule: "reconciliation", ok: true, extracted: 100, expected: 100, detail: "" },
      { rule: "closing_balance", ok: true, extracted: 100, expected: 100, detail: "" },
      { rule: "opening_balance", ok: true, extracted: 200, expected: 200, detail: "" },
    ],
    expectedClosingBalance: 100,
    calculatedClosingBalance: 100,
    difference: 0,
    missingTransactionCount: 0,
    ...over,
  } as never;
}

// ── Reconciliation confidence ─────────────────────────────────────────────────

test("a fully reconciling statement scores 100", () => {
  assert.equal(reconciliationConfidence(validation()), 100);
});

test("a failed reconciliation check dominates the score", () => {
  const failed = validation({
    valid: false,
    checks: [
      { rule: "reconciliation", ok: false, extracted: 1, expected: 2, detail: "" },
      { rule: "closing_balance", ok: true, extracted: 1, expected: 1, detail: "" },
      { rule: "opening_balance", ok: true, extracted: 1, expected: 1, detail: "" },
    ],
  });
  const score = reconciliationConfidence(failed);
  assert.ok(score !== null && score < 40, `reconciliation is weighted heaviest, got ${score}`);
});

test("missing rows are penalised beyond the per-rule checks", () => {
  const withMissing = validation({ missingTransactionCount: 4 });
  assert.equal(reconciliationConfidence(withMissing), 80, "100 − 4×5");
});

test("no checks yields null, not zero", () => {
  // Absent is honest; 0 would read as "checked and failed".
  assert.equal(reconciliationConfidence(validation({ checks: [] })), null);
  assert.equal(reconciliationConfidence(null), null);
  assert.equal(reconciliationConfidence(undefined), null);
});

test("the score is always clamped to 0..100", () => {
  const catastrophic = validation({
    checks: [{ rule: "reconciliation", ok: false, extracted: 0, expected: 0, detail: "" }],
    missingTransactionCount: 999,
  });
  const score = reconciliationConfidence(catastrophic);
  assert.ok(score !== null && score >= 0 && score <= 100);
});

// ── The trio ──────────────────────────────────────────────────────────────────

test("the three metrics stay separate and are never averaged", () => {
  const trio = buildConfidenceTrio({ extractionConfidence: 92, classificationConfidence: 79, validation: validation() });
  assert.equal(trio.extraction, 92);
  assert.equal(trio.classification, 79);
  assert.equal(trio.reconciliation, 100);
  // The mean would be 90.33 — no field may hold it.
  assert.ok(![trio.extraction, trio.classification, trio.reconciliation].includes(90));
});

test("unmeasured metrics are null, never zero", () => {
  const trio = buildConfidenceTrio({ classificationConfidence: 79 });
  assert.equal(trio.extraction, null, "a run predating the split has no extraction score");
  assert.equal(trio.reconciliation, null);
  assert.equal(trio.classification, 79);
});

test("values are clamped and rounded", () => {
  const trio = buildConfidenceTrio({ extractionConfidence: 120, classificationConfidence: -5, reconciliationConfidence: 78.6 });
  assert.equal(trio.extraction, 100);
  assert.equal(trio.classification, 0);
  assert.equal(trio.reconciliation, 79);
});

test("a pre-computed reconciliation score wins over deriving one", () => {
  const trio = buildConfidenceTrio({ reconciliationConfidence: 55, validation: validation() });
  assert.equal(trio.reconciliation, 55, "the worker's authoritative value is preferred");
});

// ── Backwards compatibility ───────────────────────────────────────────────────

test("the deprecated field keeps carrying CLASSIFICATION, not an average", () => {
  const trio = buildConfidenceTrio({ extractionConfidence: 92, classificationConfidence: 79, reconciliationConfidence: 100 });
  assert.equal(legacyConfidence(trio), 79, "existing integrations must see the same number as before");
  assert.notEqual(legacyConfidence(trio), 90, "must not become an average");
});

test("the row mapping falls back to the legacy column for old runs", () => {
  const server = read("lib/accounting/server.ts");
  assert.match(server, /classification: toNumber\(row\.classification_confidence \?\? null\) \?\? toNumber\(row\.confidence \?\? null\)/);
  assert.match(server, /extraction: toNumber\(row\.extraction_confidence \?\? null\)/);
});

test("migration 019 backfills classification from the legacy column only", () => {
  const sql = read("supabase/migrations/019_confidence_split.sql");
  assert.match(sql, /add column if not exists classification_confidence/);
  assert.match(sql, /add column if not exists reconciliation_confidence/);
  assert.match(sql, /set classification_confidence = confidence/);
  // extraction/reconciliation must NOT be backfilled — they were never measured.
  assert.ok(!/set extraction_confidence =/.test(sql));
  assert.ok(!/set reconciliation_confidence =/.test(sql));
  assert.match(sql, /DEPRECATED/);
});

test("the worker writes all three and keeps the legacy column", () => {
  const worker = read("workers/accounting_worker/main.py");
  // classification_confidence used to be the mean over EVERY row, unresolved
  // ones included — which is not a weaker confidence but a different quantity,
  // one that falls as the ledger grows. It is now the mean over classified rows
  // only; the deprecated `confidence` column below keeps the historical value so
  // existing readers are unaffected.
  assert.match(worker, /"classification_confidence": classification_confidence_value/);
  assert.match(
    worker,
    /classified_scores = \[/,
    "the classified-only mean must be derived, not reused from avg_confidence",
  );
  assert.match(worker, /"reconciliation_confidence": reconciliation_confidence\(/);
  assert.match(worker, /"confidence": round\(avg_confidence, 2\)/, "legacy column unchanged");
  // A missing migration must degrade, not fail the run.
  assert.match(worker, /"classification_confidence",\n\s*"reconciliation_confidence",/);
});

test("the UI shows three labelled metrics and never averages them", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /function ConfidenceTrio/);
  for (const label of ["Extraction", "Classification", "Reconciliation"]) {
    assert.match(ui, new RegExp(`label: "${label}"`), `must render ${label}`);
  }
  // Unmeasured metrics render as an em dash, not 0%.
  assert.match(ui, /item\.value == null \? "—"/);
  // No bare `run.confidence` percentage without naming which metric it is.
  assert.ok(!/`\$\{Math\.round\(run\.confidence\)\}%`/.test(ui), "bare unlabelled percentages must be gone");
});

test("the labels match the three names agreed in the plan", () => {
  assert.equal(CONFIDENCE_LABELS.extraction, "Extraction Confidence");
  assert.equal(CONFIDENCE_LABELS.classification, "Classification Confidence");
  assert.equal(CONFIDENCE_LABELS.reconciliation, "Reconciliation Confidence");
});

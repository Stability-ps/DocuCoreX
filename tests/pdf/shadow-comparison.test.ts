import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const shadow = await import("@/lib/pdf/shadowComparison.ts");

const OPENING = 10_000;

// A reconciling statement: `rows` debit lines with a consistent running balance.
function statement(parser: string, rows: number, over: Record<string, unknown> = {}) {
  const transactions = Array.from({ length: rows }, (_, i) => ({
    date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
    description: `MERCHANT NAME ${i + 1}`,
    debit: 10,
    credit: null,
    balance: OPENING - 10 * (i + 1),
  }));
  const lines = transactions.map((t) => `${t.date} ${t.description} 10.00 ${t.balance!.toFixed(2)}`);
  return {
    parser,
    pageCount: 4,
    pages: [0, 1, 2, 3].map((p) => ({ pageNumber: p + 1, text: lines.slice(p * 18, (p + 1) * 18).join("\n"), words: [], tables: [], lines: [] })),
    combinedText: lines.join("\n"),
    transactions,
    metadata: { openingBalance: OPENING, closingBalance: OPENING - 10 * rows, statementPeriodStart: "2026-02-01", statementPeriodEnd: "2026-02-28", accountNumber: "123" },
    warnings: [],
    ...over,
  } as never;
}

// ── Individual metrics ────────────────────────────────────────────────────────

test("wrapped-description recovery detects truncated tails", () => {
  const clean = statement("pdfplumber", 4);
  assert.equal(shadow.wrappedDescriptionRecovery(clean), 1);

  const wrapped = statement("pdfplumber", 4, {
    transactions: [
      { date: "2026-02-01", description: "PAYMENT TO ACME AND", debit: 10, credit: null, balance: 9990 },
      { date: "2026-02-02", description: "SETTLEMENT REF", debit: 10, credit: null, balance: 9980 },
      { date: "2026-02-03", description: "CLEAN MERCHANT", debit: 10, credit: null, balance: 9970 },
      { date: "2026-02-04", description: "ANOTHER CLEAN ONE", debit: 10, credit: null, balance: 9960 },
    ],
  });
  assert.equal(shadow.wrappedDescriptionRecovery(wrapped), 0.5, "two of four end mid-phrase");
});

test("merchant description quality rejects stubs and bare references", () => {
  assert.equal(shadow.merchantDescriptionQuality(statement("pdfplumber", 4)), 1);
  const poor = statement("pdfplumber", 2, {
    transactions: [
      { date: "2026-02-01", description: "4471", debit: 10, credit: null, balance: 9990 },
      { date: "2026-02-02", description: "REAL MERCHANT", debit: 10, credit: null, balance: 9980 },
    ],
  });
  assert.equal(shadow.merchantDescriptionQuality(poor), 0.5);
});

test("grouping quality requires both a date and an amount", () => {
  const broken = statement("pdfplumber", 2, {
    transactions: [
      { date: "2026-02-01", description: "OK", debit: 10, credit: null, balance: 9990 },
      { date: null, description: "ORPHANED CONTINUATION", debit: null, credit: null, balance: null },
    ],
  });
  assert.equal(shadow.groupingQuality(broken), 0.5);
});

test("row continuity measures the running-balance chain", () => {
  assert.equal(shadow.rowContinuity(statement("pdfplumber", 10)), 1);
  const broken = statement("pdfplumber", 3, {
    transactions: [
      { date: "2026-02-01", description: "A", debit: 10, credit: null, balance: 9990 },
      { date: "2026-02-02", description: "B", debit: 10, credit: null, balance: 5000 },
      { date: "2026-02-03", description: "C", debit: 10, credit: null, balance: 4990 },
    ],
  });
  assert.equal(shadow.rowContinuity(broken), 0.5, "one of two links holds");
});

test("missing fields are enumerated by name", () => {
  const partial = statement("pdfplumber", 2, { metadata: { openingBalance: OPENING } });
  const missing = shadow.missingFields(partial);
  assert.ok(missing.includes("closingBalance"));
  assert.ok(missing.includes("accountNumber"));
  assert.ok(!missing.includes("openingBalance"));
});

// ── Verdict ───────────────────────────────────────────────────────────────────

test("reconciliation outranks every soft metric", () => {
  // Azure wins on description quality but does NOT reconcile.
  const current = statement("pdfplumber", 60);
  const azureBroken = statement("azure_di", 60, { metadata: { openingBalance: OPENING, closingBalance: 999 } });
  const result = shadow.compareExtractions(current, azureBroken, "pdfplumber");
  assert.equal(result.wouldAzureHaveBeenBetter, false);
  assert.match(result.reason, /reconciliation outranks/i);
});

test("Azure wins when it reconciles and the current provider does not", () => {
  const currentBroken = statement("pdfplumber", 60, { metadata: { openingBalance: OPENING, closingBalance: 999 } });
  const azure = statement("azure_di", 60);
  const result = shadow.compareExtractions(currentBroken, azure, "pdfplumber");
  assert.equal(result.wouldAzureHaveBeenBetter, true);
  assert.match(result.reason, /Azure reconciles/i);
});

test("balances and totals are reported but never decide the verdict", () => {
  // Identical quality, different figures — must be a tie, not an Azure win.
  const current = statement("pdfplumber", 60);
  const azure = statement("azure_di", 60);
  const result = shadow.compareExtractions(current, azure, "pdfplumber");
  const balanceMetrics = result.metrics.filter((m) => ["openingBalance", "closingBalance", "debitTotal", "creditTotal"].includes(m.metric));
  assert.equal(balanceMetrics.length, 4);
  assert.ok(balanceMetrics.every((m) => m.favours === "tie"), "a different figure is not automatically a better one");
  assert.equal(result.wouldAzureHaveBeenBetter, false);
});

test("all thirteen requested metrics are reported", () => {
  const result = shadow.compareExtractions(statement("pdfplumber", 60), statement("azure_di", 60), "pdfplumber");
  const expected = [
    "extractionConfidence", "transactionCount", "openingBalance", "closingBalance",
    "debitTotal", "creditTotal", "reconciliationDifference", "wrappedDescriptionRecovery",
    "merchantDescriptionQuality", "transactionGroupingQuality", "pageCoverage",
    "rowContinuity", "missingFields",
  ];
  assert.deepEqual(result.metrics.map((m) => m.metric).sort(), expected.sort());
  assert.equal(result.currentProvider, "pdfplumber");
  assert.ok(result.score.current + result.score.azure + result.score.ties > 0);
});

test("an unavailable Azure yields an honest, non-committal report", () => {
  const result = shadow.compareExtractions(statement("pdfplumber", 60), null, "pdfplumber");
  assert.equal(result.azureAvailable, false);
  assert.equal(result.wouldAzureHaveBeenBetter, false);
  assert.deepEqual(result.metrics, []);
  assert.match(result.reason, /no result/i);
});

// ── Isolation guarantees ──────────────────────────────────────────────────────

test("shadow mode is opt-in and cannot touch the exported workbook", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /SHADOW_AZURE_ENABLED = process\.env\.ACCOUNTING_SHADOW_AZURE === "true"/, "opt-in only");
  assert.match(route, /if \(!SHADOW_AZURE_ENABLED\) return;/);
  // It must run only AFTER the audit log, i.e. after the workbook exists.
  const auditIdx = route.indexOf("accounting_extraction_completed");
  const shadowIdx = route.indexOf("await runShadowComparison(");
  assert.ok(auditIdx > 0 && shadowIdx > auditIdx, "shadow must run after the run has succeeded");
  // It must never write to the run itself.
  const fn = route.slice(route.indexOf("async function runShadowComparison"), route.indexOf("type ProcessBody"));
  assert.ok(!/accounting_statement_runs/.test(fn), "shadow must not update the run");
  assert.ok(!/accounting_transactions/.test(fn), "shadow must not touch transactions");
  assert.match(fn, /catch \(shadowError\)/, "every failure is swallowed");
});

test("the comparison module is pure — no I/O, no env reads", () => {
  const src = read("lib/pdf/shadowComparison.ts");
  assert.ok(!/process\.env/.test(src));
  assert.ok(!/fetch\(/.test(src));
  assert.ok(!/supabase/i.test(src));
});

test("migration 018 creates the observational table", () => {
  const sql = read("supabase/migrations/018_shadow_comparison.sql");
  assert.match(sql, /create table if not exists public\.extraction_shadow_comparisons/);
  for (const col of ["current_provider", "azure_available", "would_azure_have_been_better", "reason", "metrics", "score"]) {
    assert.match(sql, new RegExp(col), `must record ${col}`);
  }
  assert.match(sql, /enable row level security/);
});

// ── Sampling gate ─────────────────────────────────────────────────────────────

function sampleEvidence(over: Record<string, unknown> = {}) {
  return {
    extractionConfidence: 97,
    reconciliationConfidence: 100,
    reconciliationDifference: 0,
    missingTransactionCount: 0,
    merged: statement("pdfplumber", 60),
    extractionRequiresReview: false,
    ...over,
  } as never;
}

test("a complete extraction is skipped and never costs an Azure call", () => {
  const d = shadow.decideShadowSample(sampleEvidence());
  assert.equal(d.sample, false);
  assert.match(d.reason, /already complete/i);
});

test("each shortfall condition triggers a sample", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["low extraction confidence", { extractionConfidence: 94 }, /extraction confidence 94/],
    ["imperfect reconciliation confidence", { reconciliationConfidence: 80 }, /reconciliation confidence 80/],
    ["non-zero difference", { reconciliationDifference: -12.5 }, /difference -12\.50/],
    ["missing rows", { missingTransactionCount: 3 }, /3 transaction row\(s\) missing/],
    ["extraction-level review", { extractionRequiresReview: true }, /review required by the extraction gate/],
  ];
  for (const [label, over, expected] of cases) {
    const d = shadow.decideShadowSample(sampleEvidence(over));
    assert.equal(d.sample, true, label);
    assert.match(d.reason, expected, label);
  }
});

test("wrapped and multi-line descriptions trigger a sample", () => {
  const wrapped = statement("pdfplumber", 2, {
    transactions: [
      { date: "2026-02-01", description: "PAYMENT TO ACME AND", debit: 10, credit: null, balance: 9990 },
      { date: "2026-02-02", description: "CLEAN MERCHANT", debit: 10, credit: null, balance: 9980 },
    ],
  });
  assert.match(shadow.decideShadowSample(sampleEvidence({ merged: wrapped })).reason, /wrapped transaction descriptions/);

  const multiline = statement("pdfplumber", 1, {
    transactions: [{ date: "2026-02-01", description: "ACME LTD\nTRADING AS FOO", debit: 10, credit: null, balance: 9990 }],
  });
  assert.equal(shadow.hasMultiLineDescriptions(multiline), true);
  assert.match(shadow.decideShadowSample(sampleEvidence({ merged: multiline })).reason, /multi-line merchant descriptions/);
});

test("missing balances trigger a sample and are named", () => {
  const noClosing = statement("pdfplumber", 60, { metadata: { openingBalance: 10000 } });
  const d = shadow.decideShadowSample(sampleEvidence({ merged: noClosing }));
  assert.equal(d.sample, true);
  assert.match(d.reason, /missing closingBalance/);
});

test("classification-driven review does NOT trigger a sample", () => {
  // The worker's per-transaction review flags are categorisation decisions.
  // Azure cannot influence them, so they must never buy an Azure call.
  const d = shadow.decideShadowSample(sampleEvidence({ extractionRequiresReview: false }));
  assert.equal(d.sample, false, "only EXTRACTION-level review may sample");
});

test("every shortfall is reported, not just the first", () => {
  const d = shadow.decideShadowSample(sampleEvidence({ extractionConfidence: 50, reconciliationDifference: 9.99, missingTransactionCount: 2 }));
  assert.match(d.reason, /extraction confidence/);
  assert.match(d.reason, /difference/);
  assert.match(d.reason, /missing/);
});

test("skipped runs are recorded, and Azure is not called for them", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  const fn = route.slice(route.indexOf("async function runShadowComparison"), route.indexOf("type ProcessBody"));
  const gateIdx = fn.indexOf("decideShadowSample({");
  const azureIdx = fn.indexOf("await extractWithAzureDocumentIntelligence(");
  assert.ok(gateIdx > 0 && azureIdx > gateIdx, "the gate must precede the Azure call");
  assert.match(fn, /shadow_skipped: true/);
  assert.match(fn, /shadow_skip_reason: sampleDecision\.reason/);
  // The skip path returns BEFORE Azure.
  const skipBlock = fn.slice(fn.indexOf("if (!sampleDecision.sample)"), azureIdx);
  assert.match(skipBlock, /return;/, "skip must return before the Azure call");
  assert.ok(!/extractWithAzureDocumentIntelligence/.test(skipBlock));
});

test("migration 020 records the skip fields", () => {
  const sql = read("supabase/migrations/020_shadow_sampling.sql");
  for (const col of ["shadow_skipped", "shadow_skip_reason", "sample_reason", "extraction_confidence", "reconciliation_confidence"]) {
    assert.match(sql, new RegExp(`add column if not exists ${col}`), `must add ${col}`);
  }
});

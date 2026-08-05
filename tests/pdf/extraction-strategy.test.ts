import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { selectExtractionStrategy } = await import("@/lib/pdf/extractionStrategy.ts");
const { acceptExtraction } = await import("@/lib/pdf/acceptExtraction.ts");
const { resolveDetectedType } = await import("@/lib/ocr/detectedType.ts");

type AnalysisOverrides = Record<string, unknown>;

function analysis(over: AnalysisOverrides = {}) {
  return {
    pageCount: 4,
    totalTextLength: 4000,
    averageTextPerPage: 1000,
    pages: [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, textLength: 1000, hasText: true })),
    isDigitalPdf: true,
    kind: "digital",
    needsOcr: false,
    confidence: 90,
    extractedText: "",
    reasons: [],
    characters: 4000,
    averageCharsPerPage: 1000,
    ...over,
  } as never;
}

const OPENING_BALANCE = 10_000;
const DEBIT_PER_ROW = 10;

// A realistic statement: `rows` dated debit lines spread over 4 pages, with a
// consistent running balance and a closing balance that reconciles exactly.
// The scoring model is tuned for real statements, so a fixture has to be of
// realistic size to clear the confidence floor — a two-row stub legitimately
// lands in review.
function statement(parser = "pdfplumber", rows = 60, over: Record<string, unknown> = {}) {
  const transactions = Array.from({ length: rows }, (_, i) => ({
    date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
    description: `PURCHASE ${i + 1}`,
    debit: DEBIT_PER_ROW,
    credit: null,
    balance: OPENING_BALANCE - DEBIT_PER_ROW * (i + 1),
  }));
  const lines = transactions.map((t, i) => `${String((i % 28) + 1).padStart(2, "0")}/02/2026 ${t.description} ${DEBIT_PER_ROW.toFixed(2)} ${t.balance!.toFixed(2)}`);
  const perPage = Math.ceil(lines.length / 4);
  const pages = [0, 1, 2, 3].map((p) => ({
    pageNumber: p + 1,
    text: lines.slice(p * perPage, (p + 1) * perPage).join("\n"),
    words: [],
    tables: [],
    lines: [],
  }));
  return {
    parser,
    pageCount: 4,
    pages,
    combinedText: lines.join("\n"),
    transactions,
    metadata: { openingBalance: OPENING_BALANCE, closingBalance: OPENING_BALANCE - DEBIT_PER_ROW * rows },
    warnings: [],
    ...over,
  } as never;
}

const goodResult = statement;

// ---- selectExtractionStrategy ------------------------------------------------

test("genuine digital PDF stays on native extraction and does not run OCR upfront", () => {
  const plan = selectExtractionStrategy(analysis());
  assert.equal(plan.strategy, "native");
  assert.equal(plan.ocrUpfront, false, "OCR cannot improve correctly embedded text");
  assert.equal(plan.runNative, true);
});

test("digital PDF below the confidence floor keeps OCR available", () => {
  const plan = selectExtractionStrategy(analysis({ confidence: 40 }));
  assert.equal(plan.strategy, "native_then_ocr");
  assert.equal(plan.ocrUpfront, true);
});

test("weak-text (mixed) document runs native then OCR", () => {
  const plan = selectExtractionStrategy(analysis({ kind: "weak-text", averageTextPerPage: 40, confidence: 45 }));
  assert.equal(plan.strategy, "native_then_ocr");
  assert.equal(plan.ocrUpfront, true);
});

test("scanned document routes to OCR but still collects native candidates", () => {
  const plan = selectExtractionStrategy(analysis({ kind: "scanned", averageTextPerPage: 2, confidence: 5, isDigitalPdf: false, needsOcr: true }));
  assert.equal(plan.strategy, "ocr_primary");
  assert.equal(plan.ocrUpfront, true);
  assert.equal(plan.runNative, true, "pdfplumber can still recover a layer PDF.js missed");
});

// ---- acceptExtraction: the single gate ---------------------------------------

test("a clean native result is validated", () => {
  const outcome = acceptExtraction(analysis(), { pdfplumber: goodResult() });
  assert.equal(outcome.verdict, "validated");
  assert.equal(outcome.accepted, true);
  assert.deepEqual(outcome.rejectionReasons, []);
  assert.equal(outcome.ocrEngine, null, "native result credits no OCR engine");
});

test("failed reconciliation is never validated", () => {
  const broken = statement("pdfplumber", 60, { metadata: { openingBalance: OPENING_BALANCE, closingBalance: 12345 } });
  const outcome = acceptExtraction(analysis(), { pdfplumber: broken });
  assert.notEqual(outcome.verdict, "validated");
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.rejectionReasons.some((r: string) => /reconciliation/i.test(r)));
});

test("missing closing balance is never validated even with plenty of text", () => {
  const incomplete = statement("pdfplumber", 60, { metadata: { openingBalance: OPENING_BALANCE } });
  const outcome = acceptExtraction(analysis(), { pdfplumber: incomplete });
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.rejectionReasons.some((r: string) => /closing balance is missing/i.test(r)));
});

test("no extractable content yields the failed verdict, not review", () => {
  const empty = { parser: "pdfjs", pageCount: 0, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [] } as never;
  const outcome = acceptExtraction(analysis(), { pdfjs: empty });
  assert.equal(outcome.verdict, "failed");
});

test("high OCR confidence alone cannot promote a broken result to validated", () => {
  // 99% engine confidence, but the statement does not reconcile.
  const confidentButWrong = statement("ocr", 60, {
    metadata: { openingBalance: OPENING_BALANCE, closingBalance: 99999 },
    confidence: 99,
    confidenceSource: "tesseract-tsv",
  });
  const outcome = acceptExtraction(analysis(), { ocr: confidentButWrong });
  assert.equal(outcome.accepted, false, "OCR legibility is not extraction correctness");
  assert.ok(outcome.rejectionReasons.some((r: string) => /reconciliation/i.test(r)));
});

test("material engine disagreement forces review instead of being hidden", () => {
  // Both engines reconcile internally, but they read a materially different
  // number of rows and a different closing balance.
  const tesseract = statement("ocr", 60);
  const mistral = statement("mistral_ocr", 45);
  const outcome = acceptExtraction(analysis(), { ocr: tesseract, mistral });

  assert.equal(outcome.accepted, false, "a conflict between engines must not be silently resolved");
  assert.ok(outcome.selection.disagreements.length > 0, "the disagreement is recorded, not dropped");
  const fields = outcome.selection.disagreements.map((d: { field: string }) => d.field);
  assert.ok(fields.includes("transactionCount"), `expected transactionCount disagreement, got ${fields.join(",")}`);
  assert.ok(fields.includes("closingBalance"), `expected closingBalance disagreement, got ${fields.join(",")}`);
  // Every disagreement is surfaced as a rejection reason a human can read.
  assert.ok(outcome.rejectionReasons.some((r: string) => /disagree/i.test(r)));
});

// ── The acceptance gate is scoped to what the document is ─────────────────────

// A clean digital invoice: real text, but no transactions and no balances —
// because an invoice does not have them.
function invoice() {
  return {
    parser: "pdfplumber",
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: "INVOICE 123 Acme Ltd Total R1,150.00", words: [], tables: [], lines: [] },
      { pageNumber: 2, text: "Terms: 30 days. Banking details overleaf.", words: [], tables: [], lines: [] },
    ],
    combinedText: "INVOICE 123\nAcme Ltd\nDate 2026-02-01\nSubtotal 1000.00\nVAT 150.00\nTotal R1,150.00",
    transactions: [],
    metadata: {},
    warnings: [],
  } as never;
}

test("a clean invoice is VALIDATED as a document — statement checks do not apply", () => {
  const outcome = acceptExtraction(analysis(), { pdfplumber: invoice() }, { expect: "document" });
  assert.equal(outcome.verdict, "validated");
  assert.equal(outcome.accepted, true, "native extraction succeeded; nothing to escalate");
  assert.deepEqual(outcome.rejectionReasons, []);
});

test("the same invoice IS rejected when a bank statement was expected", () => {
  const outcome = acceptExtraction(analysis(), { pdfplumber: invoice() }, { expect: "bank_statement" });
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.rejectionReasons.some((r: string) => /transaction rows/i.test(r)));
  assert.ok(outcome.rejectionReasons.some((r: string) => /closing balance is missing/i.test(r)));
});

test("the default expectation is the STRICTER one", () => {
  // Forgetting to declare `expect` must not silently drop reconciliation from a
  // real statement — the safe default is bank_statement.
  const withoutOption = acceptExtraction(analysis(), { pdfplumber: invoice() });
  const asStatement = acceptExtraction(analysis(), { pdfplumber: invoice() }, { expect: "bank_statement" });
  assert.equal(withoutOption.verdict, asStatement.verdict);
  assert.deepEqual(withoutOption.rejectionReasons, asStatement.rejectionReasons);
});

test("a document with NO readable text still fails, so OCR escalation still happens", () => {
  const empty = { parser: "pdfjs", pageCount: 1, pages: [], combinedText: "", transactions: [], metadata: {}, warnings: [] } as never;
  const outcome = acceptExtraction(analysis({ kind: "scanned", confidence: 5 }), { pdfjs: empty }, { expect: "document" });
  assert.equal(outcome.verdict, "failed");
  assert.equal(outcome.accepted, false, "a scanned document must still reach OCR");
});

test("a partially-extracted multi-page document is rejected on quality, not banking", () => {
  // 1 of 4 pages yielded text — a mixed PDF where the rest are scanned images.
  // OCR may fix this, so it must escalate. The reason must be about extraction
  // quality, never about balances.
  const partial = {
    parser: "pdfplumber",
    pageCount: 4,
    pages: [
      { pageNumber: 1, text: "CONTRACT OF SALE between the parties hereto", words: [], tables: [], lines: [] },
      { pageNumber: 2, text: "", words: [], tables: [], lines: [] },
      { pageNumber: 3, text: "", words: [], tables: [], lines: [] },
      { pageNumber: 4, text: "", words: [], tables: [], lines: [] },
    ],
    combinedText: "CONTRACT OF SALE between the parties hereto",
    transactions: [],
    metadata: {},
    warnings: [],
  } as never;
  const outcome = acceptExtraction(analysis(), { pdfplumber: partial }, { expect: "document" });
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.rejectionReasons.some((r: string) => /only 25% of pages/i.test(r)));
  assert.ok(!outcome.rejectionReasons.some((r: string) => /balance|reconcil|transaction/i.test(r)), "reasons must not mention banking");
});

test("an unclassified document is never relabelled a bank statement without evidence", () => {
  // The old default wrote "bank_statement" back to documents.detected_type for
  // ANY unknown document, which flipped it onto the statement policy on the next
  // run and escalated a clean digital file through both OCR engines.
  assert.equal(resolveDetectedType("unknown", 0, null, null), "unknown", "an invoice must not become a statement");
  assert.equal(resolveDetectedType(undefined, 0, null, null), "unknown");
  // A known type is always preserved.
  assert.equal(resolveDetectedType("invoice", 0, null, null), "invoice");
  assert.equal(resolveDetectedType("contract", 12, 1000, 900), "contract", "evidence never overrides an explicit type");
  // Only real statement evidence earns the statement label.
  assert.equal(resolveDetectedType("unknown", 40, 1000, 900), "bank_statement");
  assert.equal(resolveDetectedType("unknown", 40, null, null), "unknown", "rows alone are not enough");
  assert.equal(resolveDetectedType("unknown", 0, 1000, 900), "unknown", "balances alone are not enough");
});

test("engine disagreement still forces review for a generic document", () => {
  // The agreement check is not statement-specific: two engines reading different
  // text is a defect whatever the document is.
  const a = statement("ocr", 60);
  const b = statement("mistral_ocr", 45);
  const outcome = acceptExtraction(analysis(), { ocr: a, mistral: b }, { expect: "document" });
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.selection.disagreements.length > 0);
});

test("both OCR engines are recorded in the comparison with exactly one winner", () => {
  const outcome = acceptExtraction(analysis(), { ocr: goodResult("ocr"), mistral: goodResult("mistral_ocr") });
  const engines = outcome.ocrEngineComparison.map((c: { engine: string }) => c.engine).sort();
  assert.deepEqual(engines, ["mistral_ocr", "tesseract"]);
  assert.ok(outcome.ocrEngineComparison.every((c: { score: number }) => typeof c.score === "number"));
  assert.equal(outcome.ocrEngineComparison.filter((c: { won: boolean }) => c.won).length, 1);
});

test("tesseract keeps the tie — it is the primary engine", () => {
  // Identical output from both engines ⇒ equal scores ⇒ primary wins.
  const outcome = acceptExtraction(analysis(), { ocr: goodResult("ocr"), mistral: goodResult("mistral_ocr") });
  assert.equal(outcome.ocrEngine, "tesseract");
});

test("mistral wins when it materially outscores tesseract", () => {
  // Tesseract recovered nothing usable; Mistral recovered a full statement.
  const weakTesseract = { parser: "ocr", pageCount: 1, pages: [], combinedText: "sm", transactions: [], metadata: {}, warnings: [], confidence: 30 } as never;
  const outcome = acceptExtraction(analysis(), { ocr: weakTesseract, mistral: statement("mistral_ocr") });
  assert.equal(outcome.ocrEngine, "mistral_ocr");
  const winner = outcome.ocrEngineComparison.find((c: { won: boolean }) => c.won);
  assert.equal(winner?.engine, "mistral_ocr");
});

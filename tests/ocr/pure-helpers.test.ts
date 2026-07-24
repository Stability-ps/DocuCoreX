import test from "node:test";
import assert from "node:assert/strict";
import { selectOcrProvider, selectExtractionProvider, isSelectionError } from "../../lib/providers/selection.ts";
import {
  modelSupportsVision,
  modelSupportsStructuredOutput,
  estimateImageTokens,
  estimateTextTokens,
  estimateCostUsd,
} from "../../lib/providers/openai/models.ts";
import { scoreTextAccuracy } from "../../lib/ocr/accuracy.ts";
import { planExtractionMethod, ocrFallback } from "../../lib/ocr/method.ts";

const noKeys = { openai: false, googleVision: false, aws: false, azureFormRecognizer: false };

// ── Provider selection: no mock in production ────────────────────────────────

test("OCR selection prefers OpenAI vision when configured", () => {
  const r = selectOcrProvider({ configured: { ...noKeys, openai: true }, allowMock: false });
  assert.deepEqual(r, { provider: "openai_vision" });
});

test("OCR selection falls back to Tesseract when only it is available", () => {
  const r = selectOcrProvider({ configured: noKeys, tesseractAvailable: true, allowMock: false });
  assert.deepEqual(r, { provider: "tesseract" });
});

test("OCR selection REFUSES mock in production (real backend, nothing configured)", () => {
  const r = selectOcrProvider({ configured: noKeys, tesseractAvailable: false, allowMock: false });
  assert.ok(isSelectionError(r));
});

test("OCR selection allows mock only when explicitly permitted (local/demo)", () => {
  const r = selectOcrProvider({ configured: noKeys, tesseractAvailable: false, allowMock: true });
  assert.deepEqual(r, { provider: "mock" });
});

test("OCR override is honoured when available and rejected otherwise", () => {
  assert.deepEqual(
    selectOcrProvider({ configured: { ...noKeys, openai: true }, override: "openai_vision", allowMock: false }),
    { provider: "openai_vision" },
  );
  assert.ok(isSelectionError(selectOcrProvider({ configured: noKeys, override: "openai_vision", allowMock: false })));
  assert.ok(isSelectionError(selectOcrProvider({ configured: noKeys, override: "bogus", allowMock: true })));
});

test("Extraction selection prefers OpenAI and refuses mock in production", () => {
  assert.deepEqual(selectExtractionProvider({ configured: { ...noKeys, openai: true }, allowMock: false }), {
    provider: "openai",
  });
  assert.ok(isSelectionError(selectExtractionProvider({ configured: noKeys, allowMock: false })));
});

// ── Model capability ─────────────────────────────────────────────────────────

test("model capability checks", () => {
  assert.equal(modelSupportsVision("gpt-4o-mini"), true);
  assert.equal(modelSupportsVision("gpt-4o"), true);
  assert.equal(modelSupportsVision("gpt-3.5-turbo"), false);
  assert.equal(modelSupportsStructuredOutput("gpt-4o-mini"), true);
});

// ── Token / cost estimation ──────────────────────────────────────────────────

test("token + cost estimation", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateImageTokens(1024, 1024, "high"), 85 + 170 * 2 * 2);
  assert.equal(estimateImageTokens(1024, 1024, "low"), 85);
  // 1M input tokens on gpt-4o-mini ≈ $0.15
  assert.equal(estimateCostUsd({ model: "gpt-4o-mini", inputTokens: 1_000_000, outputTokens: 0 }), 0.15);
});

// ── Accuracy scoring ─────────────────────────────────────────────────────────

test("accuracy scoring: identical text scores 100 F1", () => {
  const s = scoreTextAccuracy("Invoice Total R 1,234.56", "Invoice Total R 1,234.56");
  assert.equal(s.f1, 100);
});

test("accuracy scoring: disjoint text scores 0", () => {
  const s = scoreTextAccuracy("alpha beta gamma", "one two three");
  assert.equal(s.f1, 0);
});

test("accuracy scoring: partial overlap yields intermediate recall", () => {
  const s = scoreTextAccuracy("the quick brown fox", "the quick brown fox jumps over");
  assert.ok(s.recall > 50 && s.recall < 100);
  assert.equal(s.precision, 100);
});

// ── Method planning + Tesseract fallback ─────────────────────────────────────

test("method planning by PDF kind", () => {
  assert.deepEqual(planExtractionMethod("digital", "openai_vision"), {
    primary: "pdfjs",
    methods: ["pdfjs", "pdfplumber"],
    needsOcr: false,
  });
  assert.deepEqual(planExtractionMethod("scanned", "openai_vision"), {
    primary: "openai_vision",
    methods: ["openai_vision"],
    needsOcr: true,
  });
  assert.deepEqual(planExtractionMethod("weak-text", "tesseract").methods, ["pdfjs", "pdfplumber", "tesseract"]);
});

test("Tesseract is preserved as the fallback engine", () => {
  assert.equal(ocrFallback("openai_vision", true), "tesseract");
  assert.equal(ocrFallback("openai_vision", false), null);
  assert.equal(ocrFallback("tesseract", true), null);
});

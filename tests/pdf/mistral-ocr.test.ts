import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { decideMistralOcr } = await import("@/lib/pdf/mistralDecision.ts");
const { buildMistralOcrBody, meanPageConfidence, isMistralConfigured, mistralOcrModel } = await import("@/lib/pdf/extractWithMistralOcr.ts");
const { aggregateTsvConfidence, heuristicConfidence } = await import("@/lib/pdf/ocrConfidence.ts");

// Healthy baseline: primary OCR ran, was confident, and everything reconciled.
function evidence(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    enhanced: false,
    strategy: "ocr_primary",
    ocrAttempted: true,
    ocrChars: 5000,
    ocrConfidence: 92,
    selectionConfidence: 85,
    transactionCount: 40,
    hasOpeningBalance: true,
    hasClosingBalance: true,
    validationRequiresReview: false,
    ...over,
  } as never;
}

// ---- decideMistralOcr: the four trigger conditions ---------------------------

test("healthy primary extraction does not call the paid second engine", () => {
  const d = decideMistralOcr(evidence());
  assert.equal(d.needed, false);
});

test("never called when MISTRAL_API_KEY is absent", () => {
  // Even a completely broken extraction must not attempt an unconfigured engine.
  const d = decideMistralOcr(evidence({ configured: false, transactionCount: 0, validationRequiresReview: true }));
  assert.equal(d.needed, false);
  assert.match(d.reason, /not configured/i);
});

test("trigger 1 — low primary OCR confidence", () => {
  const d = decideMistralOcr(evidence({ ocrConfidence: 55 }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /confidence/i);
});

test("trigger 1b — primary OCR recovered essentially nothing", () => {
  const d = decideMistralOcr(evidence({ ocrChars: 12, ocrConfidence: null }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /12 chars/);
});

test("trigger 2 — important fields missing", () => {
  assert.equal(decideMistralOcr(evidence({ transactionCount: 0 })).needed, true);
  assert.equal(decideMistralOcr(evidence({ hasClosingBalance: false })).needed, true);
  assert.match(decideMistralOcr(evidence({ hasOpeningBalance: false })).reason, /opening balance/i);
});

test("trigger 3 — reconciliation failed", () => {
  const d = decideMistralOcr(evidence({ validationRequiresReview: true }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /reconciliation/i);
});

test("trigger 4 — Enhanced OCR overrides an otherwise healthy result", () => {
  const d = decideMistralOcr(evidence({ enhanced: true }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /enhanced/i);
});

test("missing fields on a native-strategy document still escalate", () => {
  // A digital PDF whose native parse lost the closing balance is WRONG, so a
  // second engine is worth trying even though the text layer is intact.
  const d = decideMistralOcr(evidence({ strategy: "native", ocrAttempted: false, ocrChars: 0, ocrConfidence: null, hasClosingBalance: false }));
  assert.equal(d.needed, true);
});

test("a generic document never escalates for missing banking fields", () => {
  // Every statement-shaped trigger is "on" — zero transactions, no balances,
  // reconciliation unsatisfiable, low transaction-weighted score. None of them
  // may spend money on a second engine for an invoice or a contract.
  const d = decideMistralOcr(
    evidence({
      expect: "document",
      strategy: "native",
      ocrAttempted: false,
      ocrChars: 0,
      ocrConfidence: null,
      transactionCount: 0,
      hasOpeningBalance: false,
      hasClosingBalance: false,
      validationRequiresReview: true,
      selectionConfidence: 12,
    }),
  );
  assert.equal(d.needed, false, "no OCR on a clean digital document that simply is not a statement");
  assert.match(d.reason, /generic document/i);
});

test("a generic document DOES escalate when OCR itself did badly", () => {
  // The one legitimate reason to try a second engine on a generic document.
  assert.equal(decideMistralOcr(evidence({ expect: "document", ocrConfidence: 40 })).needed, true);
  assert.equal(decideMistralOcr(evidence({ expect: "document", ocrChars: 5, ocrConfidence: null })).needed, true);
  assert.equal(decideMistralOcr(evidence({ expect: "document", enhanced: true })).needed, true);
});

test("omitting expect keeps the stricter statement behaviour", () => {
  const d = decideMistralOcr(evidence({ transactionCount: 0 }));
  assert.equal(d.needed, true, "default must not silently relax a statement");
});

test("a native-strategy document that passed every check is left alone", () => {
  const d = decideMistralOcr(evidence({ strategy: "native", ocrAttempted: false, ocrChars: 0, ocrConfidence: null }));
  assert.equal(d.needed, false, "OCR cannot improve correctly embedded text");
});

// ---- Request shape (verified against docs.mistral.ai/api/endpoint/ocr) -------

test("request body matches the documented OCR endpoint contract", () => {
  const body = buildMistralOcrBody("QkFTRTY0", "mistral-ocr-4-0") as Record<string, unknown>;
  assert.equal(body.model, "mistral-ocr-4-0");
  const document = body.document as Record<string, unknown>;
  assert.equal(document.type, "document_url");
  assert.equal(document.document_url, "data:application/pdf;base64,QkFTRTY0", "local PDFs go in as a base64 data URI");
  assert.equal(body.include_image_base64, false);
  // include_blocks defaults to TRUE on mistral-ocr-4-0 and would bloat the
  // response with per-block metadata we never read.
  assert.equal(body.include_blocks, false);
  assert.equal(body.confidence_scores_granularity, "page");
});

test("default model is mistral-ocr-4-0 and is env-overridable", () => {
  assert.equal(mistralOcrModel(), process.env.MISTRAL_OCR_MODEL?.trim() || "mistral-ocr-4-0");
});

test("isMistralConfigured tracks the environment variable", () => {
  const original = process.env.MISTRAL_API_KEY;
  try {
    delete process.env.MISTRAL_API_KEY;
    assert.equal(isMistralConfigured(), false);
    process.env.MISTRAL_API_KEY = "placeholder-not-a-real-key";
    assert.equal(isMistralConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = original;
  }
});

// ---- Confidence normalisation ------------------------------------------------

test("page confidences are averaged and scaled to 0..100", () => {
  // Mistral reports 0..1.
  assert.equal(meanPageConfidence([{ confidence_scores: { page: 0.9 } }, { confidence_scores: { page: 0.8 } }] as never), 85);
  // Already-percentage values are passed through rather than double-scaled.
  assert.equal(meanPageConfidence([{ confidence_scores: { page: 90 } }] as never), 90);
  // No scores at all ⇒ null, never a fabricated number.
  assert.equal(meanPageConfidence([{ markdown: "text" }] as never), null);
  assert.equal(meanPageConfidence([] as never), null);
});

test("tesseract TSV aggregation ignores layout rows and empty text", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    // Layout rows carry conf -1 and no text — they must not drag the mean down.
    "1\t1\t0\t0\t0\t0\t0\t0\t600\t800\t-1\t",
    "5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t96\tOpening",
    "5\t1\t1\t1\t1\t2\t70\t10\t50\t20\t90\tBalance",
    "5\t1\t1\t1\t1\t3\t70\t10\t50\t20\t30\tsmudged",
  ].join("\n");
  const result = aggregateTsvConfidence(tsv);
  assert.ok(result);
  assert.equal(result!.words, 3);
  assert.equal(result!.confidence, 72, "mean of 96, 90, 30");
  assert.equal(result!.lowConfidenceWordRatio, 0.33, "one of three words below 60");
});

test("tesseract TSV with no recognised words yields null, not a fake score", () => {
  const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t600\t800\t-1\t";
  assert.equal(aggregateTsvConfidence(tsv), null);
});

test("heuristic fallback keeps its previous behaviour", () => {
  // Unchanged from the original inline formula, so a worker that cannot run the
  // TSV pass reports exactly what it reported before.
  assert.equal(heuristicConfidence(0, 0), 0);
  assert.equal(heuristicConfidence(8000, 4), 95, "clamped at 95");
  assert.equal(heuristicConfidence(80, 4), 10, "clamped at 10");
  assert.equal(heuristicConfidence(1600, 4), 50);
});

// ---- Secret hygiene ----------------------------------------------------------

// Mentioning the variable NAME inside a quoted string (e.g. a "not configured"
// message) is safe; interpolating its VALUE is not. Strip string literals first
// so the check only sees actual code identifiers.
function stripStringLiterals(line: string): string {
  return line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, "``");
}

test("the Mistral engine never logs or returns the API key", () => {
  const source = read("lib/pdf/extractWithMistralOcr.ts");
  const lines = source.split("\n");

  // The key value may only appear where it is read and where it is used as the
  // bearer credential — never on a logging or return path.
  for (const line of lines) {
    const code = stripStringLiterals(line);
    if (!/\bapiKey\b|process\.env\.MISTRAL_API_KEY/.test(code)) continue;
    if (/pdfLog\(|console\./.test(code)) {
      assert.fail(`API key value referenced on a logging line: ${line.trim()}`);
    }
    if (/^\s*(return|.*:)\s*apiKey\b/.test(code)) {
      assert.fail(`API key value returned: ${line.trim()}`);
    }
  }

  // The only permitted uses: reading it, the configured check, and the header.
  const usageLines = lines.filter((l) => /\bapiKey\b/.test(stripStringLiterals(l)));
  assert.ok(usageLines.length > 0, "the engine must actually read the key");
  for (const line of usageLines) {
    assert.match(
      line,
      /const apiKey = process\.env|if \(!apiKey\)|Authorization: `Bearer \$\{apiKey\}`/,
      `unexpected use of the API key: ${line.trim()}`,
    );
  }

  // Error paths must not echo the request body — it embeds the whole document.
  assert.ok(!/pdfLog\([^)]*\bbody\b\s*[,)]/.test(source), "request body must never be logged");
});

test("the Mistral engine logs no document content", () => {
  const source = read("lib/pdf/extractWithMistralOcr.ts");
  for (const line of source.split("\n")) {
    if (!/pdfLog\(/.test(line)) continue;
    // Only lengths/counts/status may be logged, never the text itself.
    assert.ok(
      !/\bcombinedText\s*[,}]|\bmarkdown\b|\bbase64Pdf\b|errorBody\s*[,}]/.test(line),
      `document content referenced in a log line: ${line.trim()}`,
    );
  }
});

test("no hardcoded Mistral credential anywhere in the engine or its config", () => {
  for (const file of ["lib/pdf/extractWithMistralOcr.ts", "lib/pdf/mistralDecision.ts", ".env.example"]) {
    const source = read(file);
    // Mistral keys are long opaque tokens; assert no assignment of a literal.
    assert.ok(!/MISTRAL_API_KEY\s*=\s*["'`][A-Za-z0-9_\-]{12,}/.test(source), `${file} appears to contain a literal key`);
  }
});

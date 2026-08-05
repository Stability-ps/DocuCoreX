import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const azure = await import("@/lib/pdf/extractWithAzureDocumentIntelligence.ts");
const { decideAzureExtraction } = await import("@/lib/pdf/azureDecision.ts");
const { acceptExtraction } = await import("@/lib/pdf/acceptExtraction.ts");

const ENDPOINT = "https://example.cognitiveservices.azure.com";
const KEY = "placeholder-not-a-real-key";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Scripted fetch: each call returns the next queued response.
function scriptFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const accepted202 = (operationUrl = `${ENDPOINT}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/abc?api-version=2024-11-30`) =>
  new Response(null, { status: 202, headers: { "operation-location": operationUrl } });

function succeeded(body: Record<string, unknown>) {
  return new Response(JSON.stringify({ status: "succeeded", analyzeResult: body }), { status: 200, headers: { "content-type": "application/json" } });
}

const STATEMENT_CONTENT = [
  "01/02/2026 PURCHASE ONE 10.00 9990.00",
  "02/02/2026 PURCHASE TWO 10.00 9980.00",
  "Opening Balance 10000.00",
  "Closing Balance 9980.00",
].join("\n");

// ── Pure helpers ──────────────────────────────────────────────────────────────

test("analyze URL matches the documented v4.0 GA contract", () => {
  const url = azure.buildAnalyzeUrl(ENDPOINT);
  assert.ok(url.startsWith(`${ENDPOINT}/documentintelligence/documentModels/prebuilt-layout:analyze`), url);
  assert.match(url, /api-version=2024-11-30/);
  assert.match(url, /_overload=analyzeDocument/);
  // A trailing slash on the endpoint must not produce a double slash.
  assert.equal(azure.buildAnalyzeUrl(`${ENDPOINT}/`), url);
});

test("word confidence is averaged and scaled to 0..100", () => {
  assert.equal(azure.meanWordConfidence([{ words: [{ confidence: 0.9 }, { confidence: 0.8 }] }] as never), 85);
  assert.equal(azure.meanWordConfidence([{ words: [{ confidence: 95 }] }] as never), 95, "already-percentage values pass through");
  assert.equal(azure.meanWordConfidence([{ words: [] }] as never), null, "no scores ⇒ null, never a fabricated number");
  assert.equal(azure.meanWordConfidence([] as never), null);
});

test("Azure tables become row-major tables the scorer can count", () => {
  const tables = azure.toExtractionTables([
    { rowCount: 2, columnCount: 2, cells: [
      { rowIndex: 0, columnIndex: 0, content: "Date" }, { rowIndex: 0, columnIndex: 1, content: "Amount" },
      { rowIndex: 1, columnIndex: 0, content: "01/02/2026" }, { rowIndex: 1, columnIndex: 1, content: "10.00" },
    ] },
  ] as never);
  assert.deepEqual(tables, [[["Date", "Amount"], ["01/02/2026", "10.00"]]]);
  assert.deepEqual(azure.toExtractionTables(undefined), []);
});

test("content is split per page using spans, with a lines fallback", () => {
  const content = "PAGE ONE\fPAGE TWO";
  const bySpan = azure.splitContentByPages(content, [
    { pageNumber: 1, spans: [{ offset: 0, length: 8 }] },
    { pageNumber: 2, spans: [{ offset: 9, length: 8 }] },
  ] as never);
  assert.deepEqual(bySpan.map((p) => p.text), ["PAGE ONE", "PAGE TWO"]);

  const byLines = azure.splitContentByPages(content, [{ pageNumber: 1, lines: [{ content: "A" }, { content: "B" }] }] as never);
  assert.equal(byLines[0].text, "A\nB");
});

// ── Provider behaviour ────────────────────────────────────────────────────────

test("unconfigured Azure returns null and makes no request", async () => {
  const f = scriptFetch([accepted202()]);
  try {
    const result = await withEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: undefined, AZURE_DOCUMENT_INTELLIGENCE_KEY: undefined }, () =>
      azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.equal(result, null);
    assert.deepEqual(f.calls, []);
  } finally {
    f.restore();
  }
});

test("success: submits base64, polls, and normalises the result", async () => {
  const f = scriptFetch([
    accepted202(),
    succeeded({
      content: STATEMENT_CONTENT,
      pages: [{ pageNumber: 1, spans: [{ offset: 0, length: STATEMENT_CONTENT.length }], words: [{ confidence: 0.96 }, { confidence: 0.94 }] }],
      tables: [{ rowCount: 1, columnCount: 2, cells: [{ rowIndex: 0, columnIndex: 0, content: "01/02/2026" }, { rowIndex: 0, columnIndex: 1, content: "10.00" }] }],
      paragraphs: [{ content: "Opening Balance 10000.00" }],
    }),
  ]);
  try {
    const result = await withEnv(
      { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY, AZURE_DOCUMENT_INTELLIGENCE_POLL_MS: "1" },
      () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"),
    );
    assert.ok(result);
    assert.equal(result!.parser, "azure_di");
    assert.equal(result!.combinedText, STATEMENT_CONTENT);
    assert.equal(result!.confidence, 95);
    assert.equal(result!.confidenceSource, "azure-word");
    assert.ok(result!.transactions.length > 0, "rows parsed from the returned content");
    // Submit went to the analyze URL as a POST; the poll used the operation URL.
    assert.equal(f.calls[0].method, "POST");
    assert.match(f.calls[0].url, /prebuilt-layout:analyze/);
    assert.match(f.calls[1].url, /analyzeResults/);
    const debug = result!.metadata._azureDebug as Record<string, unknown>;
    for (const field of ["provider", "pages", "tables", "paragraphs", "words", "confidence", "duration_ms"]) {
      assert.ok(field in debug, `parser debug must expose ${field}`);
    }
    assert.equal(debug.provider, "azure_di");
  } finally {
    f.restore();
  }
});

test("API failure returns a failure result rather than throwing", async () => {
  const f = scriptFetch([new Response("quota exceeded", { status: 403 })]);
  try {
    const result = await withEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY }, () =>
      azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.ok(result);
    assert.equal(result!.parser, "azure_di");
    assert.equal(result!.combinedText, "");
    assert.equal(result!.metadata._azureRequiresReview, false, "a 4xx is a config problem, not a transient one");
    assert.match(result!.warnings[0], /403/);
  } finally {
    f.restore();
  }
});

test("a failed analysis operation is reported, not retried forever", async () => {
  const f = scriptFetch([
    accepted202(),
    new Response(JSON.stringify({ status: "failed", error: { code: "InvalidContent", message: "unreadable" } }), { status: 200 }),
  ]);
  try {
    const result = await withEnv(
      { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY, AZURE_DOCUMENT_INTELLIGENCE_POLL_MS: "1" },
      () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.match(result!.warnings[0], /failed/);
    assert.equal(result!.metadata._azureRequiresReview, false);
  } finally {
    f.restore();
  }
});

test("timeout: polling stops at the deadline and flags review", async () => {
  const f = scriptFetch([accepted202(), new Response(JSON.stringify({ status: "running" }), { status: 200 })]);
  try {
    const result = await withEnv(
      { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY, AZURE_DOCUMENT_INTELLIGENCE_POLL_MS: "1", AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS: "30" },
      () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.ok(result);
    assert.equal(result!.combinedText, "");
    assert.match(result!.warnings[0], /timeout/i);
    assert.equal(result!.metadata._azureRequiresReview, true);
  } finally {
    f.restore();
  }
});

test("a 202 without Operation-Location is handled", async () => {
  const f = scriptFetch([new Response(null, { status: 202 })]);
  try {
    const result = await withEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY }, () =>
      azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.match(result!.warnings[0], /502/);
  } finally {
    f.restore();
  }
});

test("malformed success payloads degrade to an empty result, never a crash", async () => {
  for (const body of ["not json at all", JSON.stringify({ status: "succeeded" }), JSON.stringify({ status: "succeeded", analyzeResult: {} })]) {
    const f = scriptFetch([accepted202(), new Response(body, { status: 200 })]);
    try {
      const result = await withEnv(
        { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY, AZURE_DOCUMENT_INTELLIGENCE_POLL_MS: "1", AZURE_DOCUMENT_INTELLIGENCE_TIMEOUT_MS: "60" },
        () => azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
      assert.ok(result, body);
      assert.equal(result!.parser, "azure_di");
      assert.equal(result!.transactions.length, 0);
    } finally {
      f.restore();
    }
  }
});

test("a network error is caught and flagged for review", async () => {
  const f = scriptFetch([new Error("ECONNREFUSED")]);
  try {
    const result = await withEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY: KEY }, () =>
      azure.extractWithAzureDocumentIntelligence(PDF, "s.pdf"));
    assert.match(result!.warnings[0], /unreachable/);
    assert.equal(result!.metadata._azureRequiresReview, true);
  } finally {
    f.restore();
  }
});

// ── Routing ───────────────────────────────────────────────────────────────────

function evidence(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    enhanced: false,
    strategy: "native",
    expect: "bank_statement",
    accepted: false,
    nativeChars: 5000,
    selectionConfidence: 85,
    transactionCount: 70,
    hasOpeningBalance: true,
    hasClosingBalance: true,
    validationRequiresReview: false,
    alreadyAttempted: false,
    ...over,
  } as never;
}

test("a healthy digital PDF that passed acceptance never calls Azure", () => {
  const d = decideAzureExtraction(evidence({ accepted: true }));
  assert.equal(d.needed, false);
  assert.match(d.reason, /already passed the acceptance gate/);
});

test("Azure is skipped when unconfigured or already attempted", () => {
  assert.equal(decideAzureExtraction(evidence({ configured: false })).needed, false);
  assert.equal(decideAzureExtraction(evidence({ alreadyAttempted: true })).needed, false);
});

test("scanned document with no native text escalates to Azure", () => {
  const d = decideAzureExtraction(evidence({ strategy: "ocr_primary", nativeChars: 0 }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /only 0 chars/);
});

test("bank statement routing: the reported symptoms each trigger Azure", () => {
  assert.equal(decideAzureExtraction(evidence({ transactionCount: 0 })).needed, true);
  assert.equal(decideAzureExtraction(evidence({ hasClosingBalance: false })).needed, true);
  assert.equal(decideAzureExtraction(evidence({ validationRequiresReview: true })).needed, true);
  // The ~82% confidence case this integration targets.
  assert.equal(decideAzureExtraction(evidence({ selectionConfidence: 82 })).needed, true);
});

test("a generic document escalates on extraction quality, not banking fields", () => {
  const d = decideAzureExtraction(evidence({ expect: "document", transactionCount: 0, hasOpeningBalance: false, hasClosingBalance: false, selectionConfidence: 12 }));
  assert.equal(d.needed, true);
  assert.match(d.reason, /extraction quality/);
  assert.ok(!/balance|transaction/i.test(d.reason), "reason must not be phrased in banking terms");
});

test("Enhanced OCR forces Azure even on an accepted result", () => {
  assert.equal(decideAzureExtraction(evidence({ accepted: true, enhanced: true })).needed, true);
});

// ── Acceptance and comparison ─────────────────────────────────────────────────

function azureResult(rows: number, over: Record<string, unknown> = {}) {
  const lines = Array.from({ length: rows }, (_, i) => `0${(i % 9) + 1}/02/2026 ROW ${i + 1} 10.00 ${(10000 - 10 * (i + 1)).toFixed(2)}`);
  return {
    parser: "azure_di",
    pageCount: 4,
    pages: [0, 1, 2, 3].map((p) => ({ pageNumber: p + 1, text: lines.slice(p * 18, (p + 1) * 18).join("\n"), words: [], tables: [], lines: [] })),
    combinedText: lines.join("\n"),
    transactions: lines.map((raw, i) => ({ date: `2026-02-0${(i % 9) + 1}`, description: `ROW ${i + 1}`, debit: 10, credit: null, balance: 10000 - 10 * (i + 1), raw })),
    metadata: { openingBalance: 10000, closingBalance: 10000 - 10 * rows },
    warnings: [],
    confidence: 96,
    confidenceSource: "azure-word",
    ...over,
  } as never;
}

const analysis = {
  pageCount: 4, totalTextLength: 4000, averageTextPerPage: 1000,
  pages: [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, textLength: 1000, hasText: true })),
  isDigitalPdf: true, kind: "digital", needsOcr: false, confidence: 90,
  extractedText: "", reasons: [], characters: 4000, averageCharsPerPage: 1000,
} as never;

test("Azure output passes through the SAME acceptance gate", () => {
  const outcome = acceptExtraction(analysis, { azure: azureResult(70) }, { expect: "bank_statement" });
  assert.equal(outcome.verdict, "validated");
  assert.equal(outcome.ocrEngine, "azure_di", "the winning provider is recorded");
});

test("Azure is rejected by the same rules as everyone else", () => {
  const broken = azureResult(70, { metadata: { openingBalance: 10000, closingBalance: 55555 } });
  const outcome = acceptExtraction(analysis, { azure: broken }, { expect: "bank_statement" });
  assert.equal(outcome.accepted, false, "no Azure-specific acceptance path");
  assert.ok(outcome.rejectionReasons.some((r: string) => /reconciliation/i.test(r)));
});

test("provider comparison includes Azure alongside the OCR engines", () => {
  const tess = { ...(azureResult(20) as unknown as Record<string, unknown>), parser: "ocr", confidence: 60 } as never;
  const outcome = acceptExtraction(analysis, { azure: azureResult(70), ocr: tess }, { expect: "bank_statement" });
  const engines = outcome.ocrEngineComparison.map((c: { engine: string }) => c.engine).sort();
  assert.deepEqual(engines, ["azure_di", "tesseract"]);
  assert.equal(outcome.ocrEngineComparison.filter((c: { won: boolean }) => c.won).length, 1);
  assert.equal(outcome.ocrEngine, "azure_di", "the higher-scoring provider wins");
});

// ── Ladder / structural guarantees ────────────────────────────────────────────

test("the escalation ladder is Azure then Mistral then Tesseract", () => {
  const src = read("lib/pdf/runExtractionPipeline.ts");
  const azureIdx = src.indexOf("decideAzureExtraction({");
  const mistralIdx = src.indexOf("decideMistralOcr({");
  const tessIdx = src.indexOf("5c. Tesseract");
  assert.ok(azureIdx > 0 && mistralIdx > azureIdx, "Azure is decided before Mistral");
  assert.ok(tessIdx > mistralIdx, "Tesseract is the last rung");
  // Every rung re-enters the same gate.
  assert.equal((src.match(/acceptExtraction\(analysis, candidatesSoFar\(\), \{ expect \}\)/g) ?? []).length, 3);
});

test("Azure has no bespoke acceptance logic", () => {
  const accept = read("lib/pdf/acceptExtraction.ts");
  assert.ok(!/azure/i.test(accept.replace(/candidates\.azure|azure\?:|azure_di/g, "")), "acceptExtraction must contain no Azure-specific branching");
});

test("the Azure key is never logged or returned", () => {
  const src = read("lib/pdf/extractWithAzureDocumentIntelligence.ts");
  for (const line of src.split("\n")) {
    const code = line.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, "``");
    if (!/\bkey\b/.test(code)) continue;
    assert.ok(!/pdfLog\(|console\./.test(code), `key referenced on a logging line: ${line.trim()}`);
  }
  // Must not REQUEST markdown (prose mentioning the option is fine).
  assert.ok(!/outputContentFormat[=:]/.test(src), "must not request markdown — it would repeat the merge-coherence defect");
  assert.ok(!/markdown/.test(src.replace(/\/\/.*$/gm, "")), "markdown must not appear in code, only in comments");
});

// ── Cache guard ───────────────────────────────────────────────────────────────

test("an Enhanced request is not satisfied by a standard cached result", () => {
  const src = read("lib/pdf/runExtractionPipeline.ts");
  // The guard must key off whether the CACHED RUN was enhanced, not off which
  // providers happen to appear in its comparison. The provider-enumerating form
  // broke silently the moment a third provider was added: a cached Azure run
  // satisfied an Enhanced request that never reached Mistral or Tesseract.
  assert.match(src, /if \(cached && \(!enhancedOcr \|\| cached\.enhanced\)\)/);
  assert.ok(!/cached\.ocrEngineComparison\.some/.test(src), "must not enumerate providers to decide cache reuse");
  // The flag is recorded on every result so the guard has something to read.
  assert.match(src, /enhanced: enhancedOcr,/);
});

test("OCR_ENGINE_KEYS is gone (it was exported and never consumed)", () => {
  const merge = read("lib/pdf/mergeExtractionResults.ts");
  assert.ok(!/OCR_ENGINE_KEYS/.test(merge));
});

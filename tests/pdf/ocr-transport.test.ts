import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const { extractWithOcr, isConversionWorkerMode, __testables } = await import("@/lib/pdf/extractWithOcr.ts");

// A representative /api/ocr-text success body — the shape BOTH transports produce.
const PAYLOAD = {
  text: "01/02/2026 PAYMENT 100.00\f02/02/2026 DEPOSIT 50.00",
  pages: 2,
  confidence: 87,
  confidenceSource: "tesseract-tsv",
  lowConfidenceWordRatio: 0.05,
  warnings: [],
  reason: null,
  ocrDebug: { ocr_status: 200, ocr_text_length: 48, ocr_confidence: 87, attempts: [] },
};

// Swap in a recording fetch for the duration of one call, and restore after.
async function withRecordedFetch<T>(response: Response | Error, run: () => Promise<T>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

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

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

// ── Transport selection ───────────────────────────────────────────────────────

test("isConversionWorkerMode reflects CONVERSION_WORKER_MODE exactly", () => {
  withEnv({ CONVERSION_WORKER_MODE: "true" }, () => assert.equal(isConversionWorkerMode(), true));
  withEnv({ CONVERSION_WORKER_MODE: "false" }, () => assert.equal(isConversionWorkerMode(), false));
  withEnv({ CONVERSION_WORKER_MODE: undefined }, () => assert.equal(isConversionWorkerMode(), false));
});

test("worker mode makes NO HTTP request — not even to itself", async () => {
  // CONVERSION_WORKER_URL is deliberately set to prove the in-process branch
  // ignores it entirely and never issues a self-call.
  const { result, calls } = await withEnv(
    {
      CONVERSION_WORKER_MODE: "true",
      CONVERSION_WORKER_URL: "https://docucorex-conversion-worker.onrender.com",
      // Force `which` to fail deterministically so the engine short-circuits at
      // the 501 branch on any machine, with or without ocrmypdf installed.
      OCRMYPDF_PATH: "docucorex-nonexistent-ocr-binary",
    },
    () => withRecordedFetch(new Response("{}", { status: 200 }), () => extractWithOcr(PDF_BYTES, "statement.pdf")),
  );

  assert.deepEqual(calls, [], "worker mode must not perform any fetch");
  assert.ok(result);
  assert.equal(result!.parser, "ocr");
  const debug = result!.metadata._ocrDebug as Record<string, unknown>;
  assert.equal(debug.ocr_endpoint, "in-process", "the in-process transport labels its endpoint");
});

test("worker mode does not need CONVERSION_WORKER_URL at all", async () => {
  const { result, calls } = await withEnv(
    { CONVERSION_WORKER_MODE: "true", CONVERSION_WORKER_URL: undefined, OCRMYPDF_PATH: "docucorex-nonexistent-ocr-binary" },
    () => withRecordedFetch(new Response("{}", { status: 200 }), () => extractWithOcr(PDF_BYTES, "statement.pdf")),
  );
  assert.deepEqual(calls, []);
  // Crucially NOT null: on Vercel an unset URL means "skipped", but on the worker
  // OCR is available regardless, so the pipeline still gets a real result.
  assert.notEqual(result, null, "worker mode must not skip OCR when CONVERSION_WORKER_URL is unset");
});

test("non-worker mode posts to the conversion worker over HTTP", async () => {
  const { result, calls } = await withEnv(
    { CONVERSION_WORKER_MODE: undefined, CONVERSION_WORKER_URL: "https://worker.example.com", CONVERSION_WORKER_SECRET: undefined },
    () =>
      withRecordedFetch(
        new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { "content-type": "application/json" } }),
        () => extractWithOcr(PDF_BYTES, "statement.pdf"),
      ),
  );

  assert.deepEqual(calls, ["https://worker.example.com/api/ocr-text"], "exactly one call, to /api/ocr-text");
  assert.ok(result);
  assert.equal(result!.combinedText, PAYLOAD.text);
  assert.equal(result!.confidence, 87);
  assert.equal(result!.confidenceSource, "tesseract-tsv");
});

test("non-worker mode still returns null when CONVERSION_WORKER_URL is unset", async () => {
  const { result, calls } = await withEnv({ CONVERSION_WORKER_MODE: undefined, CONVERSION_WORKER_URL: undefined }, () =>
    withRecordedFetch(new Response("{}", { status: 200 }), () => extractWithOcr(PDF_BYTES, "statement.pdf")),
  );
  assert.equal(result, null, "unchanged Vercel behaviour: unconfigured ⇒ skipped");
  assert.deepEqual(calls, []);
});

// ── Equivalence of the two transports ─────────────────────────────────────────

test("both transports normalise an identical payload to an equivalent result", () => {
  const { toExtractionResult } = __testables;
  const viaHttp = toExtractionResult(PAYLOAD, "https://worker.example.com/api/ocr-text");
  const viaInProcess = toExtractionResult(PAYLOAD, "in-process");

  // Everything that feeds scoring, merging and validation must match exactly.
  assert.equal(viaHttp.parser, viaInProcess.parser);
  assert.equal(viaHttp.combinedText, viaInProcess.combinedText);
  assert.equal(viaHttp.pageCount, viaInProcess.pageCount);
  assert.equal(viaHttp.confidence, viaInProcess.confidence);
  assert.equal(viaHttp.confidenceSource, viaInProcess.confidenceSource);
  assert.deepEqual(viaHttp.transactions, viaInProcess.transactions);
  assert.deepEqual(viaHttp.pages, viaInProcess.pages);
  assert.deepEqual(viaHttp.warnings, viaInProcess.warnings);

  // The ONLY difference is the endpoint label carried for diagnostics.
  const httpDebug = viaHttp.metadata._ocrDebug as Record<string, unknown>;
  const localDebug = viaInProcess.metadata._ocrDebug as Record<string, unknown>;
  assert.equal(httpDebug.ocr_endpoint, "https://worker.example.com/api/ocr-text");
  assert.equal(localDebug.ocr_endpoint, "in-process");
  assert.deepEqual({ ...httpDebug, ocr_endpoint: null }, { ...localDebug, ocr_endpoint: null });
});

test("both transports degrade identically on a non-200 outcome", () => {
  const { ocrFailure } = __testables;
  const http = ocrFailure("https://worker.example.com/api/ocr-text", 504, "timed out", true);
  const local = ocrFailure("in-process", 504, "timed out", true);
  assert.equal(http.parser, local.parser);
  assert.equal(http.combinedText, local.combinedText);
  assert.deepEqual(http.warnings, local.warnings);
  assert.equal(http.metadata._ocrRequiresReview, local.metadata._ocrRequiresReview);
  assert.equal(http.confidence, null);
  assert.equal(local.confidence, null);
});

// ── No duplicated OCR logic ───────────────────────────────────────────────────

test("the OCR implementation lives in exactly one module", () => {
  const engine = read("lib/pdf/ocrEngine.ts");
  const route = read("app/api/ocr-text/route.ts");
  const client = read("lib/pdf/extractWithOcr.ts");

  // The engine owns the flag escalation, the budgets and the TSV confidence.
  assert.match(engine, /--force-ocr/);
  assert.match(engine, /--redo-ocr/);
  assert.match(engine, /--skip-text/);
  assert.match(engine, /aggregateTsvConfidence/);
  assert.match(engine, /CONVERSION_OCR_TOTAL_BUDGET_MS/);

  // Match the CALL form so a prose mention in a comment does not trip the check.
  const spawnCall = /spawnSync\s*\(/;

  // The route is a thin wrapper: no spawn, no flags, no confidence maths.
  assert.ok(!spawnCall.test(route), "route must not spawn processes itself");
  assert.ok(!/--force-ocr|--redo-ocr|--skip-text/.test(route), "route must not restate the flag escalation");
  assert.ok(!/aggregateTsvConfidence\s*\(|heuristicConfidence\s*\(/.test(route), "route must not restate confidence logic");
  assert.match(route, /runOcrText\(fileBytes, fileName, endpoint\)/, "route delegates to the shared engine");

  // The pipeline client also delegates rather than reimplementing.
  assert.ok(!spawnCall.test(client), "extractWithOcr must not spawn processes itself");
  assert.match(client, /await import\("@\/lib\/pdf\/ocrEngine"\)/, "worker mode delegates to the shared engine");

  // The flag escalation exists in exactly one place across the whole repo.
  assert.equal(
    [engine, route, client].filter((s) => /--redo-ocr/.test(s)).length,
    1,
    "the ocrmypdf flag escalation must exist in exactly one module",
  );
});

test("the API response shape is unchanged (engine body is returned verbatim)", () => {
  const route = read("app/api/ocr-text/route.ts");
  assert.match(route, /NextResponse\.json\(result\.body, \{ status: result\.status \}\)/);
  const engine = read("lib/pdf/ocrEngine.ts");
  for (const field of ["text", "pages", "confidence", "confidenceSource", "lowConfidenceWordRatio", "warnings", "reason", "ocrDebug"]) {
    assert.match(engine, new RegExp(`\\b${field}\\b`), `payload must still carry ${field}`);
  }
  // Status contract preserved: 501 no binary, 504 timeout, 500 unexpected.
  assert.match(engine, /status: 501/);
  assert.match(engine, /status: 504/);
  assert.match(engine, /status: 500/);
});

test("neither transport logs OCR'd document text", () => {
  for (const file of ["lib/pdf/ocrEngine.ts", "lib/pdf/extractWithOcr.ts"]) {
    const src = read(file);
    for (const line of src.split("\n")) {
      if (!/console\.|pdfLog\(/.test(line)) continue;
      assert.ok(!/sample:\s*(trimmed|text|combinedText)/.test(line), `${file} logs document text: ${line.trim()}`);
    }
  }
});

// ── pdfplumber stays a separate service ───────────────────────────────────────

test("the conversion worker still gets PDF_PLUMBER_URL (pdfplumber is remote)", () => {
  const yaml = read("render.yaml");
  assert.match(yaml, /- key: PDF_PLUMBER_URL/, "worker needs the pdfplumber endpoint");
  // pdfplumber has no in-process path — it is a separate Python service.
  const plumber = read("lib/pdf/extractWithPdfplumber.ts");
  assert.match(plumber, /process\.env\.PDF_PLUMBER_URL/);
  assert.ok(!/CONVERSION_WORKER_MODE/.test(plumber), "pdfplumber has no worker-mode shortcut");
});

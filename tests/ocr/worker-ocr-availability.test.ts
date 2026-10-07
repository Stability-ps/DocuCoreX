// The conversion worker has Tesseract/ocrmypdf installed and runs OCR in-process,
// but OCR selection keyed only on CONVERSION_WORKER_URL — which the worker
// deliberately does not set. Every queued OCR job the worker picked up failed
// with "No OCR provider is configured" (release audit, 2026-10-07).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { isTesseractReachable } = await import("@/lib/providers/selection.ts");

test("Tesseract is reachable over HTTP from Vercel and in-process on the worker", () => {
  assert.equal(isTesseractReachable({ conversionWorkerUrl: "https://docucorex-1.onrender.com" }), true);
  assert.equal(isTesseractReachable({ conversionWorkerMode: "true" }), true);
  assert.equal(isTesseractReachable({ conversionWorkerUrl: "  ", conversionWorkerMode: "false" }), false);
  assert.equal(isTesseractReachable({}), false);
});

test("the worker runtime selects the pipeline OCR engine instead of refusing", async () => {
  // A production worker: a real backend, no OpenAI key, binaries on the box.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-anon";
  process.env.CONVERSION_WORKER_MODE = "true";
  delete process.env.CONVERSION_WORKER_URL;
  delete process.env.OPENAI_API_KEY;
  const { detectProviderConfig } = await import("@/lib/workflow-adapters.ts");
  assert.equal(detectProviderConfig().ocr, "tesseract");
});

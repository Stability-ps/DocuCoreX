// Regression guard for a reporting mismatch: `/api/jobs/process` returns
// `providers: adapters.detection`, and that payload used to be derived from raw
// env-var presence rather than from provider selection. With AZURE_FORM_RECOGNIZER_*
// set (as it was in production), it reported `extraction: "azure_form_recognizer"`
// while OpenAI actually did the work — Azure Form Recognizer is not implemented
// anywhere in this codebase.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import type { EnvCredentials } from "../../lib/providers/reporting.ts";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { selectOcrProvider, selectExtractionProvider } = await import("@/lib/providers/selection.ts");
const { describeSelections, selectionFlags } = await import("@/lib/providers/reporting.ts");

// A production-like runtime: credentials present both for the engine this app
// implements (OpenAI) and for three it does not.
const env: EnvCredentials = {
  openai: true,
  googleVision: true,
  aws: true,
  azureFormRecognizer: true,
  mistral: true,
};

/** Mirrors resolveSelections() in workflow-adapters.ts, minus the process.env reads. */
function detect(overrides: Partial<EnvCredentials> = {}, allowMock = false) {
  const credentials = { ...env, ...overrides };
  const configured = selectionFlags(credentials);
  return describeSelections({
    env: credentials,
    ocr: selectOcrProvider({ configured, tesseractAvailable: false, allowMock }),
    extraction: selectExtractionProvider({ configured, allowMock }),
  });
}

test("credentials for unimplemented engines are withheld from selection", () => {
  assert.deepEqual(selectionFlags(env), {
    openai: true,
    googleVision: false,
    aws: false,
    azureFormRecognizer: false,
  });
});

test("credentials for unimplemented engines are never reported as the engine in use", () => {
  const detection = detect();
  assert.equal(detection.ocr, "openai");
  assert.equal(detection.extraction, "openai");
});

test("credentials for unimplemented engines are surfaced as dead config", () => {
  const detection = detect();
  assert.deepEqual([...detection.unimplemented].sort(), [
    "aws_textract",
    "azure_form_recognizer",
    "google_vision",
  ]);
  // Still reported as present — `configured` means "a key is set", which is
  // exactly what makes `unimplemented` actionable.
  assert.equal(detection.configured.azureFormRecognizer, true);
  assert.equal(detection.configured.googleVision, true);
  assert.equal(detection.configured.aws, true);
});

test("nothing runnable is reported as unavailable, not mock", () => {
  // Azure/Google/AWS keys present but OpenAI absent, real backend: selection
  // fails, and the report must not claim a mock produced the (non-)result.
  const detection = detect({ openai: false }, false);
  assert.equal(detection.ocr, "unavailable");
  assert.equal(detection.extraction, "unavailable");
  assert.deepEqual([...detection.unimplemented].sort(), [
    "aws_textract",
    "azure_form_recognizer",
    "google_vision",
  ]);
});

test("mock is reported as mock when genuinely permitted (local/demo)", () => {
  const detection = detect({ openai: false, googleVision: false, aws: false, azureFormRecognizer: false }, true);
  assert.equal(detection.ocr, "mock");
  assert.equal(detection.extraction, "mock");
  assert.deepEqual(detection.unimplemented, []);
});

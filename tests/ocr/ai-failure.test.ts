import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOpenAiError,
  buildAiFailureLog,
  aiUnavailableWarning,
  structuredExtractionFields,
  deterministicExtractionFields,
} from "../../lib/ocr/aiExtraction.ts";
import { openAiErrorCodeFromBody, safeOpenAiErrorMessage } from "../../lib/providers/openai/errors.ts";

// The real 401 body OpenAI returns for a bad key (contains a masked key + URL).
const REAL_401_BODY = JSON.stringify({
  error: {
    message: "Incorrect API key provided: sk-proj-SECRETSECRETSECRETqrst. You can find your API key at https://platform.openai.com/account/api-keys.",
    type: "invalid_request_error",
    code: "invalid_api_key",
    param: null,
  },
});

// ── 401 invalid_api_key is classified as a configuration error ───────────────

test("401 invalid_api_key is classified as a configuration error", () => {
  const err = Object.assign(new Error("OpenAI request failed (HTTP 401, invalid_api_key)"), { status: 401, code: "invalid_api_key" });
  const cls = classifyOpenAiError(err);
  assert.equal(cls.status, 401);
  assert.equal(cls.code, "invalid_api_key");
  assert.equal(cls.configuration, true);
});

test("missing-key error is also a configuration error; server errors are not", () => {
  assert.equal(classifyOpenAiError(new Error("OPENAI_API_KEY is not configured in this runtime.")).configuration, true);
  assert.equal(classifyOpenAiError(Object.assign(new Error("x"), { status: 500 })).configuration, false);
  assert.equal(classifyOpenAiError(Object.assign(new Error("x"), { status: 429, code: "rate_limit_exceeded" })).configuration, false);
});

// ── One safe log entry, whitelisted fields only ─────────────────────────────

test("the failure log is a single object with only safe, whitelisted fields", () => {
  const cls = classifyOpenAiError(Object.assign(new Error("x"), { status: 401, code: "invalid_api_key" }));
  const log = buildAiFailureLog("structured_extraction", "doc-123", cls);
  assert.deepEqual(Object.keys(log).sort(), ["configurationError", "documentId", "errorCode", "httpStatus", "stage"].sort());
  assert.equal(log.stage, "structured_extraction");
  assert.equal(log.httpStatus, 401);
  assert.equal(log.errorCode, "invalid_api_key");
  assert.equal(log.configurationError, true);
});

// ── No secret or document-content leakage ───────────────────────────────────

test("no secret, key, auth header, or document content leaks into the log/message/warning", () => {
  // An error whose message DOES contain a (masked) secret + content, as OpenAI returns.
  const leaky = Object.assign(new Error("Incorrect API key provided: sk-proj-SECRETSECRETqrst — content: Opening Balance R 1,000.00"), {
    status: 401,
    code: "invalid_api_key",
  });
  const cls = classifyOpenAiError(leaky);
  const log = JSON.stringify(buildAiFailureLog("structured_extraction", "doc-1", cls));
  const warning = aiUnavailableWarning(cls);
  const parsedCode = openAiErrorCodeFromBody(REAL_401_BODY);
  const safeMsg = safeOpenAiErrorMessage(401, parsedCode);

  for (const output of [log, warning, safeMsg]) {
    assert.doesNotMatch(output, /sk-/, "must not contain an API key");
    assert.doesNotMatch(output, /SECRET/i, "must not contain secret material");
    assert.doesNotMatch(output, /Bearer/i, "must not contain an auth header");
    assert.doesNotMatch(output, /Opening Balance|1,000\.00/, "must not contain document content");
  }
  // Code parsing still works, and the safe message keeps status + code only.
  assert.equal(parsedCode, "invalid_api_key");
  assert.equal(safeMsg, "OpenAI request failed (HTTP 401, invalid_api_key)");
});

// ── Deterministic fallback still succeeds, with a safe config warning ────────

test("deterministic fallback carries a safe configuration warning and provider", () => {
  const warn = aiUnavailableWarning({ status: 401, code: "invalid_api_key", configuration: true });
  assert.match(warn, /OPENAI_API_KEY/);
  assert.doesNotMatch(warn, /sk-/);
  const fields = deterministicExtractionFields({ openingBalance: 1000, closingBalance: 1250, totalDebits: 250, totalCredits: 500, lineItemCount: 2, aiWarning: warn });
  assert.equal(fields.provider, "deterministic");
  assert.equal(fields.aiExtractionAvailable, false);
  assert.equal(fields.aiExtractionWarning, warn);
  assert.equal(fields.openingBalance, 1000);
  assert.equal(fields.closingBalance, 1250);
});

test("deterministic fields report AI available when there was no AI failure", () => {
  const fields = deterministicExtractionFields({ openingBalance: null, closingBalance: null, totalDebits: 0, totalCredits: 0, lineItemCount: 0, aiWarning: null });
  assert.equal(fields.aiExtractionAvailable, true);
  assert.equal(fields.aiExtractionWarning, null);
});

// ── Successful OpenAI extraction is unchanged ───────────────────────────────

test("successful OpenAI extraction fields are unchanged (provider openai)", () => {
  const structured = {
    companyName: "QA TEST MERCHANT (PTY) LTD",
    accountNumber: "63012589818",
    statementPeriodStart: "2026-01-01",
    statementPeriodEnd: "2026-01-31",
    openingBalance: 1000,
    closingBalance: 1250,
    lineItems: [
      { date: "2026-01-03", description: "Customer payment received", debit: null, credit: 500, balance: 1500 },
      { date: "2026-01-10", description: "Software subscription", debit: 250, credit: null, balance: 1250 },
    ],
  };
  const fields = structuredExtractionFields(structured);
  assert.equal(fields.provider, "openai");
  assert.equal(fields.openingBalance, 1000);
  assert.equal(fields.closingBalance, 1250);
  assert.equal(fields.accountNumber, "63012589818");
  assert.equal(fields.lineItemCount, 2);
  assert.equal(fields.aiExtractionWarning, undefined); // success path adds no warning key
});

// Pure helpers for classifying OpenAI failures and building SAFE log entries,
// warnings, and extraction fields. Nothing here ever handles or emits API keys,
// auth headers, OCR text, document content, or raw OpenAI responses — only HTTP
// status, error code, and a boolean classification.
import type { StructuredExtraction } from "@/lib/providers/openai/extraction";

export type OpenAiErrorClass = { status: number | null; code: string | null; configuration: boolean };

// Classify a thrown OpenAI error. An HTTP 401 or `invalid_api_key`, or a
// "not configured" (missing key) error, is treated as a CONFIGURATION problem.
export function classifyOpenAiError(error: unknown): OpenAiErrorClass {
  const e = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : null;
  const code = typeof e.code === "string" ? e.code : null;
  const message = typeof e.message === "string" ? e.message : "";
  const configuration = status === 401 || code === "invalid_api_key" || /not configured/i.test(message);
  return { status, code, configuration };
}

// The object passed to console.error. WHITELIST ONLY — never spread the error
// (its message can contain a masked key) or any text/content.
export function buildAiFailureLog(stage: string, documentId: string, cls: OpenAiErrorClass) {
  return {
    stage,
    documentId,
    httpStatus: cls.status,
    errorCode: cls.code,
    configurationError: cls.configuration,
  };
}

// A safe, user-facing warning attached to the extraction result.
export function aiUnavailableWarning(cls: OpenAiErrorClass): string {
  return cls.configuration
    ? "AI extraction unavailable due to configuration (invalid or missing OPENAI_API_KEY); deterministic extraction used."
    : "AI extraction failed; deterministic extraction used.";
}

type Fields = Record<string, string | number | boolean | null>;

// Fields when OpenAI structured extraction SUCCEEDS (shape unchanged).
export function structuredExtractionFields(s: StructuredExtraction): Fields {
  return {
    provider: "openai",
    companyName: s.companyName,
    accountNumber: s.accountNumber,
    statementPeriodStart: s.statementPeriodStart,
    statementPeriodEnd: s.statementPeriodEnd,
    openingBalance: s.openingBalance,
    closingBalance: s.closingBalance,
    lineItemCount: s.lineItems.length,
  };
}

// Fields for the deterministic fallback. Carries a safe warning when AI was
// attempted but unavailable, so the result explicitly states AI was not used.
export function deterministicExtractionFields(input: {
  openingBalance: number | null;
  closingBalance: number | null;
  totalDebits: number;
  totalCredits: number;
  lineItemCount: number;
  aiWarning: string | null;
}): Fields {
  return {
    provider: "deterministic",
    openingBalance: input.openingBalance,
    closingBalance: input.closingBalance,
    totalDebits: input.totalDebits,
    totalCredits: input.totalCredits,
    lineItemCount: input.lineItemCount,
    aiExtractionAvailable: input.aiWarning === null,
    aiExtractionWarning: input.aiWarning,
  };
}

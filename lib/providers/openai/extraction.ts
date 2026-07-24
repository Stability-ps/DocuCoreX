// OpenAI structured extraction for digital-PDF text. Uses a strict JSON schema
// and an anti-fabrication system prompt; the numeric results are re-validated
// deterministically downstream (never trusted as-is).

import { callOpenAi, openAiModel, usageWithCost, type OpenAiUsage } from "@/lib/providers/openai/client";
import { modelSupportsStructuredOutput } from "@/lib/providers/openai/models";

const EXTRACTION_SYSTEM =
  "You extract structured data from bank-statement text. Use ONLY values explicitly present in the text — " +
  "never infer, estimate or invent figures. Copy amounts, dates and balances verbatim. If a field is absent, " +
  "return null. Respond only with JSON matching the provided schema.";

// A conservative schema: statement metadata + line items. All numeric fields
// nullable so the model is never pushed to fabricate.
export const EXTRACTION_JSON_SCHEMA = {
  name: "bank_statement_extraction",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      companyName: { type: ["string", "null"] },
      accountNumber: { type: ["string", "null"] },
      statementPeriodStart: { type: ["string", "null"] },
      statementPeriodEnd: { type: ["string", "null"] },
      openingBalance: { type: ["number", "null"] },
      closingBalance: { type: ["number", "null"] },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            date: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            debit: { type: ["number", "null"] },
            credit: { type: ["number", "null"] },
            balance: { type: ["number", "null"] },
          },
          required: ["date", "description", "debit", "credit", "balance"],
        },
      },
    },
    required: ["companyName", "accountNumber", "statementPeriodStart", "statementPeriodEnd", "openingBalance", "closingBalance", "lineItems"],
  },
  strict: true,
} as const;

// Pure: build the request body for structured extraction from already-extracted text.
export function buildExtractionBody(model: string, documentText: string) {
  return {
    model,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: EXTRACTION_JSON_SCHEMA },
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM },
      { role: "user", content: documentText },
    ],
  };
}

export type StructuredExtraction = {
  companyName: string | null;
  accountNumber: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  lineItems: Array<{ date: string | null; description: string | null; debit: number | null; credit: number | null; balance: number | null }>;
};

// Pure: parse the model's content into structured data. Tolerates a ```json fence.
export function parseStructuredContent(content: string): StructuredExtraction {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(trimmed) as StructuredExtraction;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lineItems)) {
    throw new Error("Structured extraction response did not match the expected schema.");
  }
  return parsed;
}

export type ExtractionRun = { data: StructuredExtraction; usage: OpenAiUsage; estimatedCostUsd: number; model: string };

// LIVE. Requires OPENAI_API_KEY.
export async function runStructuredExtraction(documentText: string, signal?: AbortSignal): Promise<ExtractionRun> {
  const model = openAiModel();
  if (!modelSupportsStructuredOutput(model)) {
    throw new Error(`Configured model "${model}" does not support structured output.`);
  }
  const completion = await callOpenAi(buildExtractionBody(model, documentText), signal);
  const { usage, estimatedCostUsd } = usageWithCost(completion.model, {
    prompt_tokens: completion.usage.promptTokens,
    completion_tokens: completion.usage.completionTokens,
    total_tokens: completion.usage.totalTokens,
  });
  return { data: parseStructuredContent(completion.content), usage, estimatedCostUsd, model: completion.model };
}

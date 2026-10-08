// OpenAI classification + structured extraction for document text. Uses a strict JSON schema
// and an anti-fabrication system prompt; the numeric results are re-validated
// deterministically downstream (never trusted as-is).

import { callOpenAi, openAiModel, usageWithCost, type OpenAiUsage } from "@/lib/providers/openai/client";
import { modelSupportsStructuredOutput } from "@/lib/providers/openai/models";

const EXTRACTION_SYSTEM =
  "You classify and extract structured data from business and financial documents: invoices, receipts, " +
  "bank statements, financial statements, purchase orders, payslips, tax documents and contracts. " +
  "Set documentType from what the document says it is (its heading and the labels it carries); use \"unknown\" " +
  "when it does not clearly identify itself. Use ONLY values explicitly present in the text — never infer, " +
  "estimate or invent figures, and never compute a total that is not printed. Copy amounts, dates and numbers " +
  "verbatim. If a field is absent or does not apply to this kind of document, return null. For bank statements " +
  "a line item is a transaction (date, description, debit, credit, balance); for invoices, receipts and purchase " +
  "orders it is a billed line (description, quantity, unitPrice, amount). Respond only with JSON matching the schema.";

export const EXTRACTION_DOCUMENT_TYPES = [
  "invoice",
  "receipt",
  "bank_statement",
  "financial_statement",
  "purchase_order",
  "payslip",
  "tax_document",
  "contract",
  "unknown",
] as const;

export type ExtractedDocumentType = (typeof EXTRACTION_DOCUMENT_TYPES)[number];

const nullableNumber = { type: ["number", "null"] } as const;
const nullableString = { type: ["string", "null"] } as const;

// Classification + a conservative superset of fields across document kinds.
// Every field is nullable so the model is never pushed to fabricate; numeric
// results are re-validated deterministically downstream.
export const EXTRACTION_JSON_SCHEMA = {
  name: "financial_document_extraction",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      documentType: { type: "string", enum: EXTRACTION_DOCUMENT_TYPES },
      documentNumber: nullableString,
      documentDate: nullableString,
      issuerName: nullableString,
      recipientName: nullableString,
      currency: nullableString,
      subtotal: nullableNumber,
      taxAmount: nullableNumber,
      totalAmount: nullableNumber,
      companyName: nullableString,
      accountNumber: nullableString,
      statementPeriodStart: nullableString,
      statementPeriodEnd: nullableString,
      openingBalance: nullableNumber,
      closingBalance: nullableNumber,
      lineItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            date: nullableString,
            description: nullableString,
            quantity: nullableNumber,
            unitPrice: nullableNumber,
            amount: nullableNumber,
            debit: nullableNumber,
            credit: nullableNumber,
            balance: nullableNumber,
          },
          required: ["date", "description", "quantity", "unitPrice", "amount", "debit", "credit", "balance"],
        },
      },
    },
    required: [
      "documentType",
      "documentNumber",
      "documentDate",
      "issuerName",
      "recipientName",
      "currency",
      "subtotal",
      "taxAmount",
      "totalAmount",
      "companyName",
      "accountNumber",
      "statementPeriodStart",
      "statementPeriodEnd",
      "openingBalance",
      "closingBalance",
      "lineItems",
    ],
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

export type StructuredLineItem = {
  date: string | null;
  description: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
};

export type StructuredExtraction = {
  documentType?: ExtractedDocumentType;
  documentNumber?: string | null;
  documentDate?: string | null;
  issuerName?: string | null;
  recipientName?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  taxAmount?: number | null;
  totalAmount?: number | null;
  companyName: string | null;
  accountNumber: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  lineItems: StructuredLineItem[];
};

// Pure: parse the model's content into structured data. Tolerates a ```json fence.
export function parseStructuredContent(content: string): StructuredExtraction {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(trimmed) as StructuredExtraction;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lineItems)) {
    throw new Error("Structured extraction response did not match the expected schema.");
  }
  // A type outside the schema's enum is not trusted as a classification.
  if (!EXTRACTION_DOCUMENT_TYPES.includes(parsed.documentType as ExtractedDocumentType)) {
    parsed.documentType = "unknown";
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

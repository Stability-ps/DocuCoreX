import type { DocumentRecord, DocumentDownload, ExtractionResult, OcrResult } from "@/lib/types";
import { convertDocumentContent } from "@/lib/document-conversion-engine";

export type ProviderName = "mock" | "openai" | "google_vision" | "aws_textract" | "azure_form_recognizer";

export type ProviderDetection = {
  ocr: ProviderName;
  extraction: ProviderName;
  conversion: ProviderName;
  configured: {
    openai: boolean;
    googleVision: boolean;
    aws: boolean;
    azureFormRecognizer: boolean;
  };
};

export interface OCRProvider {
  name: ProviderName;
  run(document: Pick<DocumentRecord, "id" | "name" | "storagePath" | "mimeType">): Promise<OcrResult>;
}

export interface ExtractionProvider {
  name: ProviderName;
  run(document: DocumentRecord): Promise<ExtractionResult>;
}

export interface ConversionProvider {
  name: ProviderName;
  run(document: DocumentRecord, options: { toFormat: string }): Promise<{
    id: string;
    status: DocumentDownload["status"];
    downloadPath: string;
    fileName: string;
    contentType: string;
    content: Uint8Array;
    message: string;
  }>;
}

export class MockOCRProvider implements OCRProvider {
  name = "mock" as const;

  async run(document: Pick<DocumentRecord, "id" | "name" | "storagePath" | "mimeType">): Promise<OcrResult> {
    const text = [
      `Document: ${document.name}`,
      "Statement period: 01 June 2026 - 30 June 2026",
      "Opening balance: R 84,212.40",
      "Closing balance: R 126,908.11",
      "Fuel expenses: R 4,820.31",
      "Subscriptions detected: Accounting Suite, Cloud Storage, Payroll Platform",
      "VAT transactions detected: 18",
      "Potential duplicate payments: 2",
      "Provider: mock OCR fallback",
    ].join("\n");

    return {
      id: `ocr_${document.id}`,
      documentId: document.id,
      language: "en",
      confidence: 88.4,
      text,
      layoutStatus: "complete",
      createdAt: new Date().toISOString(),
    };
  }
}

export class MockExtractionProvider implements ExtractionProvider {
  name = "mock" as const;

  async run(document: DocumentRecord): Promise<ExtractionResult> {
    return {
      id: `extraction_${document.id}`,
      documentId: document.id,
      detectedType: document.detectedType === "unknown" ? "bank_statement" : document.detectedType,
      confidence: 87.6,
      fields: {
        documentName: document.name,
        provider: "mock",
        statementPeriod: "2026-06-01 to 2026-06-30",
        openingBalance: 84212.4,
        closingBalance: 126908.11,
        income: 214980.22,
        expenses: 172284.51,
        vatTransactions: 18,
        duplicateCandidates: 2,
      },
      lineItems: [
        { date: "2026-06-03", description: "Client payment", debit: null, credit: 48200, balance: 132412.4 },
        { date: "2026-06-06", description: "Fuel Station", debit: 1240.3, credit: null, balance: 131172.1 },
        { date: "2026-06-12", description: "Cloud Storage Subscription", debit: 389, credit: null, balance: 130783.1 },
      ],
      createdAt: new Date().toISOString(),
    };
  }
}

export class MockConversionProvider implements ConversionProvider {
  name = "mock" as const;

  async run(
    document: DocumentRecord,
    options: { toFormat: string },
  ): Promise<{
    id: string;
    status: DocumentDownload["status"];
    downloadPath: string;
    fileName: string;
    contentType: string;
    content: Uint8Array;
    message: string;
  }> {
    const content = documentContent(document);
    const generated = await convertDocumentContent(
      {
        name: document.name,
        mimeType: document.mimeType,
        content,
      },
      options.toFormat,
    );

    return {
      id: `conversion_${document.id}`,
      status: "ready",
      downloadPath: `${document.workspaceId}/conversions/${document.id}/${generated.fileName}`,
      fileName: generated.fileName,
      contentType: generated.contentType,
      content: generated.content,
      message: `Conversion to ${options.toFormat} completed from extracted document content`,
    };
  }
}

function documentContent(document: DocumentRecord) {
  const record = document as DocumentRecord & { content?: Uint8Array; sourceContent?: Uint8Array };
  const content = record.sourceContent ?? record.content;
  if (!content?.length) {
    throw new Error("Original file content is unavailable for conversion.");
  }
  return content;
}

export function detectProviderConfig(): ProviderDetection {
  const configured = {
    openai: Boolean(process.env.OPENAI_API_KEY),
    googleVision: Boolean(process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS),
    aws: Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    azureFormRecognizer: Boolean(process.env.AZURE_FORM_RECOGNIZER_ENDPOINT && process.env.AZURE_FORM_RECOGNIZER_KEY),
  };

  const ocr: ProviderName = configured.googleVision
    ? "google_vision"
    : configured.aws
      ? "aws_textract"
      : configured.azureFormRecognizer
        ? "azure_form_recognizer"
        : configured.openai
          ? "openai"
          : "mock";

  const extraction: ProviderName = configured.azureFormRecognizer
    ? "azure_form_recognizer"
    : configured.aws
      ? "aws_textract"
      : configured.openai
        ? "openai"
        : "mock";

  return {
    ocr,
    extraction,
    conversion: "mock",
    configured,
  };
}

export function createWorkflowAdapters() {
  return {
    detection: detectProviderConfig(),
    ocr: new MockOCRProvider(),
    extraction: new MockExtractionProvider(),
    conversion: new MockConversionProvider(),
  };
}

export const MockOcrAdapter = MockOCRProvider;
export const MockExtractionAdapter = MockExtractionProvider;
export const MockConversionAdapter = MockConversionProvider;

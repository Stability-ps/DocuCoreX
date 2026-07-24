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
    artifacts?: Array<{ fileName: string; contentType: string; content: Uint8Array }>;
    message: string;
  }>;
}

export class MockOCRProvider implements OCRProvider {
  name = "mock" as const;

  async run(document: Pick<DocumentRecord, "id" | "name" | "storagePath" | "mimeType">): Promise<OcrResult> {
    // No real OCR provider is configured. Return an honest, clearly-labelled
    // placeholder — never fabricate document content or financial figures that
    // could be mistaken for a genuine extraction.
    const text = [
      "[SAMPLE OUTPUT — no OCR provider is configured for this environment]",
      `Document: ${document.name}`,
      "Real text extraction requires an OCR/AI provider key (Google Vision, Azure",
      "Form Recognizer, AWS Textract or OpenAI). This placeholder does not reflect",
      "the actual contents of the uploaded file.",
    ].join("\n");

    return {
      id: `ocr_${document.id}`,
      documentId: document.id,
      language: "en",
      // 0 confidence signals "not a real extraction" to any consumer/UI.
      confidence: 0,
      text,
      layoutStatus: "complete",
      createdAt: new Date().toISOString(),
    };
  }
}

export class MockExtractionProvider implements ExtractionProvider {
  name = "mock" as const;

  async run(document: DocumentRecord): Promise<ExtractionResult> {
    // No real extraction provider is configured. Do NOT fabricate balances, line
    // items or VAT figures — that would present invented financial data as real.
    return {
      id: `extraction_${document.id}`,
      documentId: document.id,
      detectedType: document.detectedType,
      // 0 confidence + empty fields signal "not a real extraction".
      confidence: 0,
      fields: {
        documentName: document.name,
        provider: "mock",
        sampleOnly: true,
        note: "No extraction provider configured — no fields were extracted from this document.",
      },
      lineItems: [],
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
    artifacts?: Array<{ fileName: string; contentType: string; content: Uint8Array }>;
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
      artifacts: generated.artifacts,
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

// Concrete OCR/extraction providers that fulfil the existing OCRProvider /
// ExtractionProvider interfaces by delegating to the shared extractDocument
// orchestration (which reuses lib/pdf + OpenAI + deterministic validation).
import type { DocumentRecord, ExtractionResult, OcrResult } from "@/lib/types";
import type { OCRProvider, ExtractionProvider, ProviderName } from "@/lib/workflow-adapters";
import { extractDocument } from "@/lib/ocr/extractDocument";

// OCR provider: OpenAI vision when useOpenAI (with Tesseract fallback inside the
// orchestration); Tesseract/pipeline-only otherwise.
export class PipelineOcrProvider implements OCRProvider {
  name: ProviderName;
  private useOpenAI: boolean;

  constructor(useOpenAI: boolean) {
    this.useOpenAI = useOpenAI;
    this.name = useOpenAI ? "openai" : "tesseract";
  }

  async run(document: Pick<DocumentRecord, "id" | "name" | "storagePath" | "mimeType">): Promise<OcrResult> {
    const extraction = await extractDocument(document, { useOpenAI: this.useOpenAI });
    return {
      id: `ocr_${document.id}`,
      documentId: document.id,
      language: "en",
      confidence: extraction.confidence,
      text: extraction.text,
      layoutStatus: "complete",
      createdAt: new Date().toISOString(),
    };
  }
}

export class OpenAIVisionOcrProvider extends PipelineOcrProvider {
  constructor() {
    super(true);
  }
}

// Extraction provider: OpenAI structured extraction when useOpenAI, else the
// pipeline's deterministic transactions. Always deterministically validated.
export class PipelineExtractionProvider implements ExtractionProvider {
  name: ProviderName;
  private useOpenAI: boolean;

  constructor(useOpenAI: boolean) {
    this.useOpenAI = useOpenAI;
    this.name = useOpenAI ? "openai" : "tesseract";
  }

  async run(document: DocumentRecord): Promise<ExtractionResult> {
    const extraction = await extractDocument(document, { useOpenAI: this.useOpenAI });
    return {
      id: `extraction_${document.id}`,
      documentId: document.id,
      detectedType: extraction.detectedType,
      confidence: extraction.confidence,
      fields: {
        ...extraction.fields,
        validationStatus: extraction.validationStatus,
        requiresReview: extraction.requiresReview,
      },
      lineItems: extraction.lineItems.map((item) => ({
        date: item.date,
        description: item.description,
        debit: item.debit,
        credit: item.credit,
        balance: item.balance,
      })),
      createdAt: new Date().toISOString(),
    };
  }
}

export class OpenAIExtractionProvider extends PipelineExtractionProvider {
  constructor() {
    super(true);
  }
}

// Provider that rejects at run() time — used to enforce "no mock in production":
// when selection fails to resolve a real provider, the request surfaces an error
// instead of returning fabricated output.
export class UnavailableOcrProvider implements OCRProvider {
  name: ProviderName = "mock";
  constructor(private readonly reason: string) {}
  async run(): Promise<OcrResult> {
    throw new Error(this.reason);
  }
}

export class UnavailableExtractionProvider implements ExtractionProvider {
  name: ProviderName = "mock";
  constructor(private readonly reason: string) {}
  async run(): Promise<ExtractionResult> {
    throw new Error(this.reason);
  }
}

// Pure, fully-tested provider-selection logic. Two invariants it guarantees:
//   1. Selection is explicit (priority order + optional override), not "whatever
//      key happens to be present".
//   2. NO mock provider in production: when a real Supabase backend is configured
//      and no real provider resolves, selection FAILS with an error instead of
//      silently returning a fabricated "mock" result.

export type ProviderConfigFlags = {
  openai: boolean;
  googleVision: boolean;
  aws: boolean;
  azureFormRecognizer: boolean;
};

export type OcrEngine =
  | "openai_vision"
  | "google_vision"
  | "aws_textract"
  | "azure_form_recognizer"
  | "tesseract"
  | "mock";

export type ExtractionEngine = "openai" | "azure_form_recognizer" | "aws_textract" | "mock";

export type SelectionInput = {
  configured: ProviderConfigFlags;
  /** Tesseract/ocrmypdf reachable (conversion worker or local binary). */
  tesseractAvailable?: boolean;
  /** Explicit override, e.g. process.env.OCR_PROVIDER / EXTRACTION_PROVIDER. */
  override?: string | null;
  /** Mock is only permissible when there is genuinely no backend (local/demo). */
  allowMock: boolean;
};

export type SelectionResult<T extends string> = { provider: T } | { error: string };

const OCR_PRIORITY: OcrEngine[] = [
  "openai_vision",
  "google_vision",
  "aws_textract",
  "azure_form_recognizer",
  "tesseract",
];

const EXTRACTION_PRIORITY: ExtractionEngine[] = ["openai", "azure_form_recognizer", "aws_textract"];

function ocrAvailable(engine: OcrEngine, input: SelectionInput): boolean {
  switch (engine) {
    case "openai_vision":
      return input.configured.openai;
    case "google_vision":
      return input.configured.googleVision;
    case "aws_textract":
      return input.configured.aws;
    case "azure_form_recognizer":
      return input.configured.azureFormRecognizer;
    case "tesseract":
      return Boolean(input.tesseractAvailable);
    case "mock":
      return input.allowMock;
  }
}

function extractionAvailable(engine: ExtractionEngine, input: SelectionInput): boolean {
  switch (engine) {
    case "openai":
      return input.configured.openai;
    case "azure_form_recognizer":
      return input.configured.azureFormRecognizer;
    case "aws_textract":
      return input.configured.aws;
    case "mock":
      return input.allowMock;
  }
}

export function selectOcrProvider(input: SelectionInput): SelectionResult<OcrEngine> {
  const override = (input.override ?? "").trim() as OcrEngine | "";
  if (override) {
    if (!OCR_PRIORITY.includes(override) && override !== "mock") {
      return { error: `Unknown OCR_PROVIDER override "${override}".` };
    }
    if (!ocrAvailable(override, input)) {
      return { error: `OCR_PROVIDER "${override}" is not configured/available in this runtime.` };
    }
    return { provider: override };
  }

  for (const engine of OCR_PRIORITY) {
    if (ocrAvailable(engine, input)) return { provider: engine };
  }
  if (input.allowMock) return { provider: "mock" };
  return { error: "No OCR provider is configured. Refusing to use the mock provider in production." };
}

export function selectExtractionProvider(input: SelectionInput): SelectionResult<ExtractionEngine> {
  const override = (input.override ?? "").trim() as ExtractionEngine | "";
  if (override) {
    if (!EXTRACTION_PRIORITY.includes(override) && override !== "mock") {
      return { error: `Unknown EXTRACTION_PROVIDER override "${override}".` };
    }
    if (!extractionAvailable(override, input)) {
      return { error: `EXTRACTION_PROVIDER "${override}" is not configured/available in this runtime.` };
    }
    return { provider: override };
  }

  for (const engine of EXTRACTION_PRIORITY) {
    if (extractionAvailable(engine, input)) return { provider: engine };
  }
  if (input.allowMock) return { provider: "mock" };
  return { error: "No extraction provider is configured. Refusing to use the mock provider in production." };
}

export function isSelectionError<T extends string>(result: SelectionResult<T>): result is { error: string } {
  return "error" in result;
}

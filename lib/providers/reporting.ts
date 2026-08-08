// Pure provider-*reporting* logic, the counterpart to selection.ts's provider-
// *selection* logic. Kept free of process.env and of any app imports so it can be
// unit-tested directly.
//
// The invariant it exists to enforce: what we report as the engine in use is
// derived from the same selection result used to build the adapter, never from
// raw credential presence. Reporting an engine because a key happens to be set
// is how `/api/jobs/process` came to advertise `azure_form_recognizer` — an
// engine this codebase does not implement — while OpenAI did the actual work.
import { isSelectionError } from "@/lib/providers/selection";
import type {
  OcrEngine,
  ExtractionEngine,
  ProviderConfigFlags,
  SelectionResult,
} from "@/lib/providers/selection";

export type ProviderName =
  | "mock"
  | "openai"
  | "tesseract"
  | "google_vision"
  | "aws_textract"
  | "azure_form_recognizer"
  /** Selection resolved to nothing runnable; run() will throw rather than fabricate. */
  | "unavailable";

/** Credentials present in the environment. NOT a statement that an engine is used. */
export type EnvCredentials = ProviderConfigFlags & {
  /** Secondary OCR engine — escalation only, never the primary selection. */
  mistral: boolean;
};

export type ProviderDetection = {
  /**
   * The engine that will actually run, derived from the selection result that
   * built the adapter, so it cannot drift from reality.
   */
  ocr: ProviderName;
  extraction: ProviderName;
  conversion: ProviderName;
  /**
   * Credentials present in the environment. A key can be set for an engine this
   * runtime does not implement — see `unimplemented`.
   */
  configured: EnvCredentials;
  /**
   * Engines with credentials configured that this runtime cannot execute, so
   * their keys have no effect. Surfaced to make dead configuration visible
   * instead of silently ignored.
   */
  unimplemented: ProviderName[];
};

const OCR_ENGINE_NAMES: Record<OcrEngine, ProviderName> = {
  openai_vision: "openai",
  google_vision: "google_vision",
  aws_textract: "aws_textract",
  azure_form_recognizer: "azure_form_recognizer",
  tesseract: "tesseract",
  mock: "mock",
};

const EXTRACTION_ENGINE_NAMES: Record<ExtractionEngine, ProviderName> = {
  openai: "openai",
  azure_form_recognizer: "azure_form_recognizer",
  aws_textract: "aws_textract",
  mock: "mock",
};

/** Engines a credential can be present for but which this runtime cannot execute. */
const UNIMPLEMENTED: ReadonlyArray<{ key: keyof EnvCredentials; name: ProviderName }> = [
  { key: "googleVision", name: "google_vision" },
  { key: "aws", name: "aws_textract" },
  { key: "azureFormRecognizer", name: "azure_form_recognizer" },
];

/**
 * Credentials as the selector is allowed to see them. We implement OpenAI (vision
 * + structured) and Tesseract (via the conversion worker's /api/ocr-text); keys
 * for any other cloud engine are withheld so selection can never resolve to an
 * engine with no implementation behind it.
 */
export function selectionFlags(env: EnvCredentials): ProviderConfigFlags {
  return { openai: env.openai, googleVision: false, aws: false, azureFormRecognizer: false };
}

export function describeSelections(input: {
  env: EnvCredentials;
  ocr: SelectionResult<OcrEngine>;
  extraction: SelectionResult<ExtractionEngine>;
}): ProviderDetection {
  return {
    ocr: isSelectionError(input.ocr) ? "unavailable" : OCR_ENGINE_NAMES[input.ocr.provider],
    extraction: isSelectionError(input.extraction)
      ? "unavailable"
      : EXTRACTION_ENGINE_NAMES[input.extraction.provider],
    conversion: "mock",
    configured: input.env,
    unimplemented: UNIMPLEMENTED.filter(({ key }) => input.env[key]).map(({ name }) => name),
  };
}

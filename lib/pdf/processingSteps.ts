// Shared processing-step vocabulary so the server (pipeline + background
// processor) and the UI agree on the exact labels shown to the user. The
// pipeline emits these via its onStage hook; the UI renders them in order with
// an elapsed timer.
export type ProcessingStep = "detecting" | "ocr" | "parsing" | "reconciling";

export const PROCESSING_STEP_LABELS: Record<ProcessingStep, string> = {
  detecting: "Detecting PDF type",
  ocr: "Running OCR",
  parsing: "Parsing transactions",
  reconciling: "Reconciling",
};

// Ordered for the UI stepper and for a coarse progress percentage.
export const PROCESSING_STEP_ORDER: ProcessingStep[] = ["detecting", "ocr", "parsing", "reconciling"];

// Coarse progress% per step, matching processing_jobs.progress semantics.
export const PROCESSING_STEP_PROGRESS: Record<ProcessingStep, number> = {
  detecting: 20,
  ocr: 45,
  parsing: 70,
  reconciling: 90,
};

export function processingStepLabel(step: ProcessingStep): string {
  return PROCESSING_STEP_LABELS[step];
}

// Show this once processing exceeds two minutes — scanned PDFs legitimately
// take longer, so reassure the user rather than implying a stall.
export const LONG_PROCESSING_NOTICE = "Still processing — scanned PDFs can take longer.";
export const LONG_PROCESSING_THRESHOLD_MS = 120_000;

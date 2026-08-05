// Pure decision: should Azure Document Intelligence be called?
//
// Azure is an ESCALATION provider, never a default. It runs only after the
// acceptance gate has rejected the native result (or Enhanced OCR was asked
// for), and it runs BEFORE Mistral because prebuilt-layout returns structured
// tables — which is what a bank statement's transaction rows actually are —
// whereas Mistral returns prose/markdown that has to be re-parsed by regex.
//
// The ladder is Azure → Mistral → Tesseract. Each rung re-enters
// acceptExtraction() and stops the moment a result is accepted, so a healthy
// digital PDF never reaches any of them.
import type { ExtractionExpectation } from "@/lib/pdf/acceptExtraction";
import type { ExtractionStrategy } from "@/lib/pdf/types";

function readThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

// Below this merged-selection confidence a bank statement's structured
// extraction is considered insufficient and worth a layout-aware second pass.
// The default is deliberately ABOVE the ~82% this integration was commissioned
// to fix: at 70 the reported case would have scored "good enough" and Azure
// would never have run. A healthy statement scores well clear of 85.
export const AZURE_MIN_SELECTION_CONFIDENCE = readThreshold(process.env.AZURE_MIN_SELECTION_CONFIDENCE, 85);

export type AzureEvidence = {
  /** Endpoint AND key present in this runtime. */
  configured: boolean;
  /** Explicit "Enhanced OCR" request from the caller. */
  enhanced: boolean;
  strategy: ExtractionStrategy;
  expect: ExtractionExpectation;
  /** Whether the acceptance gate rejected what we have so far. */
  accepted: boolean;
  /** Characters recovered natively (PDF.js / pdfplumber). */
  nativeChars: number;
  /** Merged selection confidence 0..100. */
  selectionConfidence: number;
  transactionCount: number;
  hasOpeningBalance: boolean;
  hasClosingBalance: boolean;
  /** Reconciliation flagged the result for review. */
  validationRequiresReview: boolean;
  /** Azure already ran for this document. */
  alreadyAttempted: boolean;
};

export type AzureDecision = { needed: boolean; reason: string };

export function decideAzureExtraction(e: AzureEvidence): AzureDecision {
  if (!e.configured) {
    return { needed: false, reason: "Azure Document Intelligence not configured" };
  }
  if (e.alreadyAttempted) {
    return { needed: false, reason: "Azure already attempted for this document" };
  }

  // Cost guard. This is the rule that keeps Azure off healthy documents: if the
  // gate accepted what native extraction produced, there is nothing to improve.
  if (e.accepted && !e.enhanced) {
    return { needed: false, reason: "extraction already passed the acceptance gate" };
  }

  if (e.enhanced) {
    return { needed: true, reason: "Enhanced OCR explicitly requested" };
  }

  // Scanned / mixed documents: no usable native text, so a layout engine is the
  // right first escalation regardless of what the document is.
  if (e.nativeChars < 40) {
    return { needed: true, reason: `native extraction recovered only ${e.nativeChars} chars` };
  }

  // Beyond this point the document HAS native text but was still rejected.
  // For a generic document that means an extraction-quality problem (partial
  // page coverage, source disagreement) — Azure's layout pass can help.
  if (e.expect === "document") {
    return { needed: true, reason: "generic document failed the acceptance gate on extraction quality" };
  }

  // Bank statements: the structured-extraction signals. These are exactly the
  // symptoms the integration targets — rows found but balances missing, or
  // reconciliation off, or overall confidence weak.
  if (e.transactionCount === 0) {
    return { needed: true, reason: "no transaction rows were extracted" };
  }
  if (!e.hasOpeningBalance || !e.hasClosingBalance) {
    const missing = [!e.hasOpeningBalance && "opening balance", !e.hasClosingBalance && "closing balance"].filter(Boolean).join(" and ");
    return { needed: true, reason: `missing ${missing} — layout extraction may recover it` };
  }
  if (e.validationRequiresReview) {
    return { needed: true, reason: "reconciliation failed — structured extraction may be incomplete" };
  }
  if (e.selectionConfidence < AZURE_MIN_SELECTION_CONFIDENCE) {
    return { needed: true, reason: `selection confidence ${e.selectionConfidence} < ${AZURE_MIN_SELECTION_CONFIDENCE}` };
  }

  return { needed: false, reason: "structured extraction is sufficient" };
}

// Single OCR/extraction orchestration shared by the OCR and extraction providers.
// It REUSES the existing lib/pdf pipeline (PDF.js → pdfplumber → Tesseract-OCR →
// accounting validation) and layers OpenAI on top — it does not re-implement any
// of that. Behaviour by document kind:
//   digital / weak-text → pipeline text → OpenAI structured extraction
//   scanned             → rasterize pages → OpenAI vision (fallback: pipeline/Tesseract)
// All numeric output is re-validated deterministically; nothing is trusted as-is.
// No document content or extracted values are logged.
import type { DocumentRecord, DocumentType } from "@/lib/types";
import { loadDocumentBytes } from "@/lib/ocr/loadDocumentBytes";
import { computeFileHash } from "@/lib/pdf/extractionCache";
import { runExtractionPipeline } from "@/lib/pdf/runExtractionPipeline";
import type { OcrEngineId } from "@/lib/pdf/types";
import { rasterizePdfToImages } from "@/lib/pdf/rasterizePdf";
import { runVisionOcr } from "@/lib/providers/openai/vision-ocr";
import { runStructuredExtraction, type StructuredExtraction } from "@/lib/providers/openai/extraction";
import { validateExtraction, type ValidationStatus } from "@/lib/ocr/validate";
import { resolveDetectedType } from "@/lib/ocr/detectedType";
import type { ExtractionMethod } from "@/lib/ocr/method";
import {
  classifyOpenAiError,
  buildAiFailureLog,
  aiUnavailableWarning,
  structuredExtractionFields,
  deterministicExtractionFields,
} from "@/lib/ocr/aiExtraction";

export type DocumentExtraction = {
  text: string;
  method: ExtractionMethod; // authoritative engine for the text
  ocrUsed: boolean;
  // Extraction QUALITY confidence from the acceptance engine (0..100). This is
  // deliberately not the PDF-type-detection confidence, and not a raw OCR
  // engine confidence — neither describes whether the extraction is correct.
  confidence: number;
  // Engine-reported OCR confidence, recorded for comparison only.
  ocrConfidence: number | null;
  ocrEngine: OcrEngineId | null;
  strategy: string;
  detectedType: DocumentType;
  fields: Record<string, string | number | boolean | null>;
  lineItems: Array<{ date: string | null; description: string | null; debit: number | null; credit: number | null; balance: number | null }>;
  validationStatus: ValidationStatus;
  requiresReview: boolean;
  openaiCostUsd: number;
  warnings: string[];
};

const cache = new Map<string, DocumentExtraction>();
const CACHE_MAX = 50;

function openAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}


/**
 * Extract a document once, reusing the pipeline + OpenAI, cached by
 * documentId+fileHash so the OCR and extraction providers don't double-call.
 */
export async function extractDocument(
  document: Pick<DocumentRecord, "id" | "name" | "storagePath" | "mimeType"> & { detectedType?: DocumentType },
  options: { useOpenAI: boolean; enhanced?: boolean },
): Promise<DocumentExtraction> {
  const bytes = await loadDocumentBytes(document.storagePath);
  if (!bytes || !bytes.length) {
    throw new Error("Original document bytes are unavailable for extraction.");
  }
  const enhanced = options.enhanced === true;
  const fileHash = computeFileHash(bytes);
  // Only apply the statement checks (transaction rows, opening/closing balance,
  // reconciliation) when the document IS a bank statement. Applying them to an
  // invoice or a contract would reject a perfectly good native extraction and
  // escalate it through both OCR engines at real cost, for a document that was
  // never going to have balances.
  const expect = document.detectedType === "bank_statement" ? "bank_statement" : "document";
  // Enhanced runs are cached separately — an enhanced request must never be
  // satisfied by a standard result that skipped the secondary OCR engine. The
  // expectation is part of the key too: reclassifying a document as a statement
  // must not reuse a result that was accepted under the laxer checks.
  const cacheKey = `${document.id}:${fileHash}:${options.useOpenAI ? "ai" : "det"}:${enhanced ? "enh" : "std"}:${expect}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const fileName = document.name || "document.pdf";
  // REUSE the existing pipeline (analyse → strategy → extract → accept → escalate).
  const pipeline = await runExtractionPipeline(bytes, fileName, { documentId: document.id, fileHash, enhancedOcr: enhanced, expect });

  const warnings = [...pipeline.warnings];
  let text = pipeline.merged.combinedText;
  let method: ExtractionMethod =
    pipeline.parserMethod === "ocr"
      ? "tesseract"
      : pipeline.parserMethod === "mistral_ocr"
        ? "mistral_ocr"
        : pipeline.parserMethod === "pdfplumber"
          ? "pdfplumber"
          : "pdfjs";
  let ocrUsed = pipeline.ocrUsed;
  let openaiCostUsd = 0;

  // Scanned path: OpenAI vision, with Tesseract (already in `text`) as the fallback.
  if (options.useOpenAI && openAiConfigured() && pipeline.analysis.kind === "scanned") {
    try {
      const images = rasterizePdfToImages(bytes, { dpi: 150, maxPages: 10 });
      if (images.length) {
        const vision = await runVisionOcr(images.map((i) => i.dataUrl));
        if (vision.text.trim().length > text.trim().length) {
          text = vision.text;
          method = "openai_vision";
          ocrUsed = true;
          openaiCostUsd += vision.estimatedCostUsd;
        }
      } else {
        warnings.push("Rasterization unavailable in this runtime — used Tesseract OCR fallback.");
      }
    } catch (error) {
      // Safe log + warning (no key/content/response); Tesseract text is already in `text`.
      const cls = classifyOpenAiError(error);
      console.error("docucorex.openai.vision_failed", buildAiFailureLog("vision_ocr", document.id, cls));
      warnings.push(
        cls.configuration
          ? "AI vision OCR unavailable due to configuration (invalid or missing OPENAI_API_KEY); Tesseract OCR fallback used."
          : "AI vision OCR failed; Tesseract OCR fallback used.",
      );
    }
  }

  // Structured extraction: OpenAI when available, else the pipeline's deterministic transactions.
  let structured: StructuredExtraction | null = null;
  let aiWarning: string | null = null;
  if (options.useOpenAI && openAiConfigured() && text.trim().length > 0) {
    try {
      const run = await runStructuredExtraction(text);
      structured = run.data;
      openaiCostUsd += run.estimatedCostUsd;
    } catch (error) {
      // Classify (401/invalid_api_key/"not configured" ⇒ configuration error),
      // log a SAFE structured entry (no key/content/response), then fall back to
      // deterministic extraction. Auth failures are NOT retried.
      const cls = classifyOpenAiError(error);
      console.error("docucorex.openai.extraction_failed", buildAiFailureLog("structured_extraction", document.id, cls));
      aiWarning = aiUnavailableWarning(cls);
      warnings.push(aiWarning);
    }
  }

  const lineItems = structured
    ? structured.lineItems
    : pipeline.merged.transactions.map((t) => ({
        date: t.date ?? null,
        description: t.description ?? null,
        debit: t.debit ?? null,
        credit: t.credit ?? null,
        balance: t.balance ?? null,
      }));

  const openingBalance = structured?.openingBalance ?? (pipeline.merged.metadata.openingBalance as number | null | undefined) ?? null;
  const closingBalance = structured?.closingBalance ?? (pipeline.merged.metadata.closingBalance as number | null | undefined) ?? null;

  // Deterministic validation — never trust LLM/OCR totals as-is.
  const validation = validateExtraction({ openingBalance, closingBalance, lineItems });
  // Combine with the pipeline's own accounting validation (either flagging review wins).
  const requiresReview = pipeline.requiresReview || validation.status !== "Ready";
  const validationStatus: ValidationStatus = validation.status === "Failed" ? "Failed" : requiresReview ? "Review Required" : "Ready";

  const fields: DocumentExtraction["fields"] = structured
    ? structuredExtractionFields(structured)
    : deterministicExtractionFields({
        openingBalance,
        closingBalance,
        totalDebits: validation.totalDebits,
        totalCredits: validation.totalCredits,
        lineItemCount: lineItems.length,
        aiWarning,
      });

  const result: DocumentExtraction = {
    text,
    method,
    ocrUsed,
    // The acceptance engine's extraction-quality confidence — NOT
    // pipeline.analysis.confidence, which only describes how digital the PDF
    // looked and says nothing about whether the extraction is correct.
    confidence: Math.round(pipeline.selection.confidence),
    ocrConfidence: pipeline.merged.confidence ?? null,
    ocrEngine: pipeline.ocrEngine,
    strategy: pipeline.strategy,
    detectedType: resolveDetectedType(document.detectedType, lineItems.length, openingBalance, closingBalance),
    fields,
    lineItems,
    validationStatus,
    requiresReview,
    openaiCostUsd: Math.round(openaiCostUsd * 1_000_000) / 1_000_000,
    warnings,
  };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, result);
  return result;
}

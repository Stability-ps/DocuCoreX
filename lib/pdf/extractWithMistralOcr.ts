// Secondary OCR engine: Mistral OCR (mistral-ocr-4-0).
//
// Deliberately mirrors lib/pdf/extractWithOcr.ts so the two engines are obvious
// siblings — same signature, same normalized ExtractionResult, same "never throw
// into the pipeline" contract. Runs ONLY when decideMistralOcr() says so; the
// OCRmyPDF/Tesseract engine remains primary.
//
// API (verified against https://docs.mistral.ai/api/endpoint/ocr):
//   POST https://api.mistral.ai/v1/ocr
//   Authorization: Bearer <MISTRAL_API_KEY>
//   { model, document: { type: "document_url", document_url: "data:application/pdf;base64,..." },
//     include_image_base64: false, include_blocks: false, confidence_scores_granularity: "page" }
//   → { model, pages: [{ index, markdown, confidence_scores: { page?, word? }, dimensions }],
//       usage_info: { pages_processed, doc_size_bytes } }
//
// SECURITY: the API key is read from the environment at call time and is never
// logged, never returned, and never persisted. Only content-free diagnostics
// (lengths, status, timings, page counts) are emitted.
import type { ExtractionResult } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

const MISTRAL_OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr";
const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-4-0";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Matches the primary engine's budget so neither can outlive the caller.
const MISTRAL_TIMEOUT_MS = readTimeoutMs(process.env.MISTRAL_OCR_TIMEOUT_MS, 120_000);
// 429 (rate limited) and 5xx are transient; retry once after a short backoff.
const MISTRAL_RETRY_DELAY_MS = 3_000;
const MISTRAL_MAX_ATTEMPTS = 2;

export function mistralOcrModel(): string {
  return process.env.MISTRAL_OCR_MODEL?.trim() || DEFAULT_MISTRAL_OCR_MODEL;
}

export function isMistralConfigured(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY?.trim());
}

type MistralOcrPage = {
  index?: number;
  markdown?: string;
  confidence_scores?: { page?: number; word?: number[] } | null;
  dimensions?: { dpi?: number; height?: number; width?: number } | null;
};

type MistralOcrResponse = {
  model?: string;
  pages?: MistralOcrPage[];
  usage_info?: { pages_processed?: number; doc_size_bytes?: number };
};

// Pure: build the request body. Kept separate from the network call so it can be
// asserted in unit tests without an API key.
export function buildMistralOcrBody(base64Pdf: string, model = mistralOcrModel()) {
  return {
    model,
    document: {
      type: "document_url" as const,
      // A data URI is the documented way to OCR a local file without the
      // two-step Files API upload.
      document_url: `data:application/pdf;base64,${base64Pdf}`,
    },
    // We only consume text — skip image payloads and OCR-4 block metadata, both
    // of which would bloat the response substantially. include_blocks defaults
    // to true on mistral-ocr-4-0, so it must be disabled explicitly.
    include_image_base64: false,
    include_blocks: false,
    // Ask for a real per-page confidence. This is the signal the acceptance
    // engine compares against Tesseract's — not a character-count heuristic.
    confidence_scores_granularity: "page" as const,
  };
}

// Pure: mean of the per-page confidences the API returned, scaled to 0..100.
// Mistral reports 0..1; anything already above 1 is assumed to be a percentage.
export function meanPageConfidence(pages: MistralOcrPage[]): number | null {
  const scores = pages
    .map((p) => p.confidence_scores?.page)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!scores.length) return null;
  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  const scaled = mean <= 1 ? mean * 100 : mean;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

// Failure result carrying diagnostics so the reason is never hidden — mirrors
// ocrFailure() in extractWithOcr.ts.
function mistralFailure(status: number, detail: string, requiresReview: boolean): ExtractionResult {
  return {
    parser: "mistral_ocr",
    pageCount: 0,
    pages: [],
    combinedText: "",
    transactions: [],
    metadata: {
      _mistralDebug: { endpoint: MISTRAL_OCR_ENDPOINT, model: mistralOcrModel(), status, detail: detail.slice(0, 2000) },
      _mistralReason: `Mistral OCR returned HTTP ${status}`,
      _mistralRequiresReview: requiresReview,
    },
    warnings: [`Mistral OCR returned HTTP ${status}: ${detail.slice(0, 200)}`],
    confidence: null,
    confidenceSource: null,
  };
}

export async function extractWithMistralOcr(buffer: Uint8Array, fileName = "statement.pdf"): Promise<ExtractionResult | null> {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) {
    pdfLog("mistral.skipped", { reason: "MISTRAL_API_KEY not configured" });
    return null;
  }

  const model = mistralOcrModel();
  // Fresh copy — never a previously-consumed / possibly-detached view.
  const bytes = new Uint8Array(buffer);
  const base64Pdf = Buffer.from(bytes).toString("base64");
  pdfLog("mistral_started", { endpoint: MISTRAL_OCR_ENDPOINT, model, fileName, fileSize: bytes.byteLength });

  let lastStatus = 0;
  let lastErrorBody = "";

  for (let attempt = 1; attempt <= MISTRAL_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MISTRAL_TIMEOUT_MS);
    const started = Date.now();
    try {
      const response = await fetch(MISTRAL_OCR_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildMistralOcrBody(base64Pdf, model)),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Read the body only for a short, content-free diagnostic sample. The
        // request body (which embeds the document) is never echoed.
        const errorBody = await response.text().catch(() => "");
        lastStatus = response.status;
        lastErrorBody = errorBody;
        pdfLog("mistral.error", { status: response.status, attempt, bodyLength: errorBody.length });

        const transient = response.status === 429 || response.status >= 500;
        if (transient && attempt < MISTRAL_MAX_ATTEMPTS) {
          pdfLog("mistral.retry", { reason: `HTTP ${response.status}`, delayMs: MISTRAL_RETRY_DELAY_MS, nextAttempt: attempt + 1 });
          await new Promise((resolve) => setTimeout(resolve, MISTRAL_RETRY_DELAY_MS));
          continue;
        }
        return mistralFailure(response.status, errorBody, transient);
      }

      const data = (await response.json().catch(() => ({}))) as MistralOcrResponse;
      const apiPages = Array.isArray(data.pages) ? data.pages : [];
      // Page order is defined by `index`; do not rely on array order.
      const ordered = [...apiPages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const combinedText = ordered.map((p) => p.markdown ?? "").join("\f");
      const confidence = meanPageConfidence(ordered);

      pdfLog("mistral_finished", {
        status: response.status,
        attempt,
        model: data.model ?? model,
        // Content-free only — never the OCR'd document text.
        textLength: combinedText.trim().length,
        pages: ordered.length,
        pagesProcessed: data.usage_info?.pages_processed ?? null,
        transactions: parseTransactionsFromText(combinedText).length,
        confidence,
        ms: Date.now() - started,
      });

      return {
        parser: "mistral_ocr",
        pageCount: ordered.length || (combinedText ? 1 : 0),
        pages: ordered.map((p, index) => ({
          pageNumber: (p.index ?? index) + 1,
          text: p.markdown ?? "",
          words: [],
          tables: [],
          lines: [],
        })),
        combinedText,
        transactions: parseTransactionsFromText(combinedText),
        metadata: {
          ...parseStatementMetadata(combinedText),
          _mistralDebug: {
            endpoint: MISTRAL_OCR_ENDPOINT,
            model: data.model ?? model,
            pages_processed: data.usage_info?.pages_processed ?? null,
            doc_size_bytes: data.usage_info?.doc_size_bytes ?? null,
          },
          _mistralReason: combinedText.trim().length === 0 ? "Mistral OCR completed but returned no text" : null,
        },
        warnings: combinedText.trim().length === 0 ? ["Mistral OCR completed but returned no text."] : [],
        confidence,
        confidenceSource: confidence == null ? null : "mistral-page",
      };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const message = aborted ? `timed out after ${MISTRAL_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
      pdfLog("mistral.error", { attempt, error: message });
      return {
        parser: "mistral_ocr",
        pageCount: 0,
        pages: [],
        combinedText: "",
        transactions: [],
        metadata: {
          _mistralDebug: { endpoint: MISTRAL_OCR_ENDPOINT, model, detail: message },
          _mistralReason: aborted ? "Mistral OCR timed out" : `Mistral OCR unreachable: ${message}`,
          _mistralRequiresReview: true,
        },
        warnings: [aborted ? "Mistral OCR timed out." : `Mistral OCR unreachable: ${message}`],
        confidence: null,
        confidenceSource: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  pdfLog("mistral.error", { status: lastStatus, exhausted: true });
  return mistralFailure(lastStatus || 503, lastErrorBody, true);
}

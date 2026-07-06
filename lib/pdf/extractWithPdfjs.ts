import type { ExtractionResult, ExtractionPage, ExtractionWord } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

// Minimal structural types for the Node pdf.js legacy build (its exported types
// differ from the browser build).
type PdfTextItem = { str?: string; transform?: number[]; width?: number; height?: number };
type PdfPageProxy = { getTextContent: () => Promise<{ items: PdfTextItem[] }> };
type PdfDocProxy = { numPages: number; getPage: (n: number) => Promise<PdfPageProxy>; destroy: () => Promise<void> };
type PdfjsNode = { getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocProxy> } };

// pdf.js references DOMMatrix / Path2D / ImageData at module scope and lazily loads
// @napi-rs/canvas for RASTERISATION. Text extraction needs none of that, but the
// missing globals crash module init in Node ("DOMMatrix is not defined"). Provide
// harmless stubs so text extraction runs without a canvas backend — they are never
// exercised for getTextContent (no rendering happens).
function ensureNodeDomPolyfills(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") {
    class DOMMatrixPolyfill {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: number[] | string) {
        if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
      multiply() { return this; }
      multiplySelf() { return this; }
      preMultiplySelf() { return this; }
      translate() { return this; }
      translateSelf() { return this; }
      scale() { return this; }
      scaleSelf() { return this; }
      rotate() { return this; }
      rotateSelf() { return this; }
      invertSelf() { return this; }
      inverse() { return this; }
    }
    g.DOMMatrix = DOMMatrixPolyfill as unknown;
  }
  if (typeof g.Path2D === "undefined") g.Path2D = class {} as unknown;
  if (typeof g.ImageData === "undefined") g.ImageData = class { width = 0; height = 0; } as unknown;
}

// Server-side PDF.js TEXT extraction. Never rasterises, never requires a canvas,
// and never throws into the pipeline — on any failure it returns an empty
// normalized result plus a warning so the next extractor can still run.
export async function extractWithPdfjs(buffer: Uint8Array): Promise<ExtractionResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const pages: ExtractionPage[] = [];
  try {
    ensureNodeDomPolyfills();
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsNode;
    pdfLog("pdfjs_loaded", {});
    // Text-only options: no worker, no eval, no font-face / system fonts, so no
    // canvas / @napi-rs/canvas rasterisation backend is ever needed.
    const doc = await pdfjs.getDocument({
      data: buffer,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    pdfLog("pdfjs_renderer_skipped", { reason: "text-only extraction — rasterisation not required" });

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const words: ExtractionWord[] = [];
      const parts: string[] = [];
      for (const item of content.items) {
        const str = item.str;
        if (typeof str !== "string") continue;
        parts.push(str);
        const transform = item.transform;
        words.push({ text: str, x: transform?.[4], y: transform?.[5], width: item.width, height: item.height });
      }
      const text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
      pages.push({ pageNumber, text, words, tables: [], lines: [] });
    }
    void doc.destroy();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`PDF.js extraction failed: ${message}`);
    // A canvas / DOMMatrix / @napi-rs failure is safe to ignore for text — the
    // pipeline continues to pdfplumber and OCR.
    if (/canvas|dommatrix|napi/i.test(message)) {
      pdfLog("pdfjs_renderer_failed", { error: message, note: "continuing without PDF.js — pdfplumber / OCR will run" });
    } else {
      pdfLog("pdfjs.error", { error: message });
    }
  }

  const combinedText = pages.map((p) => p.text).join("\n");
  const result: ExtractionResult = {
    parser: "pdfjs",
    pageCount: pages.length,
    pages,
    combinedText,
    transactions: parseTransactionsFromText(combinedText),
    metadata: parseStatementMetadata(combinedText),
    warnings,
  };
  pdfLog("pdfjs_text_extracted", { pages: result.pageCount, chars: combinedText.length, transactions: result.transactions.length, ms: Date.now() - started });
  return result;
}

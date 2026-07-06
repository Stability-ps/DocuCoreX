import type { ExtractionResult, ExtractionPage, ExtractionWord } from "@/lib/pdf/types";
import { parseStatementMetadata, parseTransactionsFromText } from "@/lib/pdf/metadata";
import { pdfLog } from "@/lib/pdf/log";

// Minimal structural types for the Node pdf.js legacy build (its exported types
// differ from the browser build).
type PdfTextItem = { str?: string; transform?: number[]; width?: number; height?: number };
type PdfPageProxy = { getTextContent: () => Promise<{ items: PdfTextItem[] }> };
type PdfDocProxy = { numPages: number; getPage: (n: number) => Promise<PdfPageProxy>; destroy: () => Promise<void> };
type PdfjsNode = { getDocument: (options: { data: Uint8Array; useSystemFonts?: boolean }) => { promise: Promise<PdfDocProxy> } };

// Server-side PDF.js text extraction. Loads the legacy build (Node-safe) and
// degrades gracefully to an empty normalized result on any failure — never
// throws into the pipeline.
export async function extractWithPdfjs(buffer: Uint8Array): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const pages: ExtractionPage[] = [];
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsNode;
    const doc = await pdfjs.getDocument({ data: buffer, useSystemFonts: true }).promise;
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
      // Reconstruct rough line breaks from the text items.
      const text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
      pages.push({ pageNumber, text, words, tables: [], lines: [] });
    }
    void doc.destroy();
  } catch (error) {
    warnings.push(`PDF.js extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    pdfLog("pdfjs.error", { error: error instanceof Error ? error.message : String(error) });
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
  pdfLog("pdfjs.extract", { pages: result.pageCount, chars: combinedText.length, transactions: result.transactions.length });
  return result;
}

import { createHash } from "node:crypto";
import type { ExtractionPipelineResult } from "@/lib/pdf/types";
import { pdfLog } from "@/lib/pdf/log";

// Extraction/OCR result cache keyed by document_id + file_hash. The same PDF is
// never OCR'd or re-parsed twice: once a document has been extracted, a repeat
// request for the identical bytes reuses the stored pipeline result. A "Force
// reprocess" bypasses the cache (see runExtractionPipeline `force`).
//
// The store is an in-process LRU map. It is intentionally simple: it de-dupes
// the expensive work within a warm worker/serverless instance and across the
// retries the pipeline itself performs, without needing a new DB table. Callers
// that need cross-instance persistence still get correctness from the run-level
// dedup in the accounting process route (status === "processing" guard).

const MAX_ENTRIES = 50;
const cache = new Map<string, ExtractionPipelineResult>();

// Stable SHA-256 of the PDF bytes — the file's identity independent of name.
export function computeFileHash(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function extractionCacheKey(documentId: string, fileHash: string): string {
  return `${documentId}:${fileHash}`;
}

export function getCachedExtraction(documentId: string | null | undefined, fileHash: string | null | undefined): ExtractionPipelineResult | null {
  if (!documentId || !fileHash) return null;
  const key = extractionCacheKey(documentId, fileHash);
  const hit = cache.get(key);
  if (!hit) return null;
  // Refresh recency (LRU): re-insert so the entry moves to the newest slot.
  cache.delete(key);
  cache.set(key, hit);
  pdfLog("extraction_cache.hit", { key });
  return hit;
}

export function setCachedExtraction(documentId: string | null | undefined, fileHash: string | null | undefined, result: ExtractionPipelineResult): void {
  if (!documentId || !fileHash) return;
  const key = extractionCacheKey(documentId, fileHash);
  cache.set(key, result);
  // Evict the oldest entry when over capacity.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  pdfLog("extraction_cache.store", { key, size: cache.size });
}

// Test/maintenance helper — drop everything (used by unit tests).
export function clearExtractionCache(): void {
  cache.clear();
}

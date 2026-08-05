// Pure OCR-confidence helpers, kept out of the route module so they can be unit
// tested without pulling in next/server.
//
// The character-density heuristic these replace ("chars per page / 8") measures
// how MUCH text came back, not how well it was recognised — a confidently-read
// short page scored badly and a garbled dense page scored well. Tesseract's TSV
// output carries a real per-word recognition confidence, so we use that when it
// is available and fall back to the heuristic only when it is not.

export type TsvConfidence = {
  /** Mean per-word recognition confidence, 0..100. */
  confidence: number;
  /** Share of recognised words below 60 confidence, 0..1. */
  lowConfidenceWordRatio: number;
  /** How many recognised words the mean is based on. */
  words: number;
};

/**
 * Aggregate Tesseract TSV output into a real recognition confidence.
 *
 * TSV rows are tab-separated with `conf` at index 10 and `text` at index 11.
 * Layout rows (page/block/paragraph/line) carry conf -1 and empty text; they are
 * skipped so they cannot drag the mean down. Returns null when nothing was
 * recognised — callers must not fabricate a score in that case.
 */
export function aggregateTsvConfidence(tsv: string): TsvConfidence | null {
  const rows = tsv.split(/\r?\n/).slice(1); // drop the header row
  const confidences: number[] = [];
  for (const row of rows) {
    const columns = row.split("\t");
    if (columns.length < 12) continue;
    const conf = Number(columns[10]);
    const text = (columns[11] ?? "").trim();
    if (!Number.isFinite(conf) || conf < 0 || !text) continue;
    confidences.push(conf);
  }
  if (!confidences.length) return null;
  const mean = confidences.reduce((sum, v) => sum + v, 0) / confidences.length;
  const low = confidences.filter((c) => c < 60).length;
  return {
    confidence: Math.max(0, Math.min(100, Math.round(mean))),
    lowConfidenceWordRatio: Math.round((low / confidences.length) * 100) / 100,
    words: confidences.length,
  };
}

/** Legacy character-density estimate. Labelled "heuristic" wherever it is used. */
export function heuristicConfidence(trimmedTextLength: number, pages: number): number {
  if (trimmedTextLength === 0) return 0;
  return Math.max(10, Math.min(95, Math.round(trimmedTextLength / Math.max(1, pages) / 8)));
}

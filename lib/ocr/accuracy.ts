// Pure text-accuracy scoring for the OCR benchmark. Compares extracted text to
// a KNOWN reference string (word-level precision/recall/F1 on normalised tokens).
// It never logs or returns the text itself — only numeric scores.

function normalize(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function multiset(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

export type AccuracyScore = {
  precision: number; // % of extracted tokens that are correct
  recall: number; // % of known tokens that were found
  f1: number; // harmonic mean
  knownTokens: number;
  extractedTokens: number;
};

export function scoreTextAccuracy(extracted: string, known: string): AccuracyScore {
  const knownTokens = normalize(known);
  const extractedTokens = normalize(extracted);
  const knownSet = multiset(knownTokens);
  const extractedSet = multiset(extractedTokens);

  let overlap = 0;
  for (const [token, count] of knownSet) {
    overlap += Math.min(count, extractedSet.get(token) ?? 0);
  }

  const precision = extractedTokens.length ? (overlap / extractedTokens.length) * 100 : 0;
  const recall = knownTokens.length ? (overlap / knownTokens.length) * 100 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    knownTokens: knownTokens.length,
    extractedTokens: extractedTokens.length,
  };
}

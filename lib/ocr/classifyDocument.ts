// Pure, rule-based document classification from extracted text. Used when the
// AI classification is unavailable (no key, AI failure) and as the evidence
// recorded beside it. It reads what the document says about itself — headings
// and the labels a document of that kind carries — and returns "unknown"
// unless one type clearly leads; it never guesses between close candidates.
import type { DocumentType } from "@/lib/types";

type Signal = { re: RegExp; weight: number };

// Heading-strength signals weigh 3 (a document naming itself), supporting
// labels 1. Only the opening of the document is read for headings, since a
// statement can mention "invoice" in a transaction description.
const SIGNALS: Partial<Record<DocumentType, Signal[]>> = {
  invoice: [
    { re: /\b(?:tax\s+)?invoice\b(?!\s+(?:payment|paid|ref))/i, weight: 3 },
    { re: /\binvoice\s*(?:no\.?|number|#|date)/i, weight: 1 },
    { re: /\bbill(?:ed)?\s+to\b/i, weight: 1 },
    { re: /\b(?:amount|total|balance)\s+due\b/i, weight: 1 },
    { re: /\bdue\s+date\b/i, weight: 1 },
  ],
  receipt: [
    { re: /\b(?:cash\s+sale\s+|payment\s+|till\s+)?receipt\b/i, weight: 3 },
    { re: /\bchange\s+(?:due|given)\b/i, weight: 1 },
    { re: /\b(?:amount\s+)?(?:tendered|paid)\b/i, weight: 1 },
    { re: /\bcard\s+(?:no|number|ending)|\bauth(?:orisation|orization)?\s+code\b/i, weight: 1 },
  ],
  bank_statement: [
    { re: /\bbank\s+statement\b|\bstatement\s+of\s+account\b|\baccount\s+statement\b/i, weight: 3 },
    { re: /\bopening\s+balance\b|\bbalance\s+brought\s+forward\b/i, weight: 1 },
    { re: /\bclosing\s+balance\b|\bbalance\s+carried\s+forward\b/i, weight: 1 },
    { re: /\baccount\s+(?:no\.?|number)\b/i, weight: 1 },
  ],
  financial_statement: [
    { re: /\bstatement\s+of\s+(?:financial\s+position|comprehensive\s+income|profit\s+or\s+loss|changes\s+in\s+equity|cash\s+flows)\b/i, weight: 3 },
    { re: /\b(?:balance\s+sheet|income\s+statement|profit\s+and\s+loss|annual\s+financial\s+statements)\b/i, weight: 3 },
    { re: /\btotal\s+(?:equity|assets|liabilities)\b/i, weight: 1 },
    { re: /\b(?:revenue|turnover|gross\s+profit|net\s+profit|retained\s+earnings)\b/i, weight: 1 },
  ],
  purchase_order: [
    { re: /\bpurchase\s+order\b/i, weight: 3 },
    { re: /\bp\.?\s?o\.?\s*(?:no\.?|number|#)/i, weight: 1 },
    { re: /\bdeliver\s+to\b|\bship\s+to\b/i, weight: 1 },
  ],
  payslip: [
    { re: /\bpay\s?slip\b|\bsalary\s+advice\b|\bremuneration\s+advice\b/i, weight: 3 },
    { re: /\b(?:gross|net)\s+(?:pay|salary|earnings)\b/i, weight: 1 },
    { re: /\bemployee\s+(?:no\.?|number|code)\b/i, weight: 1 },
  ],
  contract: [
    { re: /\b(?:agreement|contract)\b/i, weight: 2 },
    { re: /\bwhereas\b|\bthe\s+parties\b|\bhereinafter\b/i, weight: 1 },
    { re: /\bsigned\s+at\b|\bwitness(?:es)?\b/i, weight: 1 },
  ],
  tax_document: [
    { re: /\b(?:IRP5|IT3\(?[abc]?\)?|EMP201|EMP501|ITR12|ITR14|VAT201)\b/, weight: 3 },
    { re: /\b(?:tax\s+(?:certificate|return|assessment|clearance)|notice\s+of\s+assessment)\b/i, weight: 3 },
  ],
};

const HEADING_CHARS = 1500;
const MIN_SCORE = 3;
const MIN_LEAD = 2;

export type TextClassification = { type: DocumentType; score: number; runnerUp: DocumentType | null; runnerUpScore: number };

export function classifyDocumentText(text: string): TextClassification {
  const opening = text.slice(0, HEADING_CHARS);
  const scores: Array<[DocumentType, number]> = [];
  for (const [type, signals] of Object.entries(SIGNALS) as Array<[DocumentType, Signal[]]>) {
    let score = 0;
    for (const signal of signals) {
      // Heading signals count only in the opening; supporting labels anywhere.
      const haystack = signal.weight >= 2 ? opening : text;
      if (signal.re.test(haystack)) score += signal.weight;
    }
    scores.push([type, score]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  const lead = best[1] - (second?.[1] ?? 0);
  const type = best[1] >= MIN_SCORE && lead >= MIN_LEAD ? best[0] : "unknown";
  return { type, score: best[1], runnerUp: second?.[0] ?? null, runnerUpScore: second?.[1] ?? 0 };
}

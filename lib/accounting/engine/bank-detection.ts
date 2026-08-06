import type { DetectedBankId } from "@/lib/accounting/engine/types";

/**
 * Evidence-based bank detection — the TypeScript mirror of
 * workers/accounting_worker/engine/detection.py. Markers, weights, thresholds
 * and the confidence formula are identical in both languages; change them
 * together or the two sides will disagree about the same statement.
 *
 * Detection reads the STATEMENT TEXT and nothing else — never the file name,
 * never the storage path. Every accounting upload is stored under
 * `{workspaceId}/accounting/fnb/{uuid}-{fileName}` (accountingStoragePath in
 * lib/accounting/server.ts), so a path-aware detector matched the FNB keyword
 * for every document ever uploaded and forced Standard Bank / ABSA / Nedbank
 * statements through the FNB parser.
 *
 * Scoring: a marker found in the header (the first HEADER_CHARS characters —
 * the letterhead, where a bank identifies itself) counts double. The same
 * marker deeper in the document counts single, because there it is more likely
 * a counterparty named in a transaction description ("STANDARD BANK TRANSFER"
 * on an FNB statement).
 */

export const UNKNOWN_BANK_ID = "unknown" as const;
export const UNKNOWN_BANK_NAME = "Unknown" as const;

/** The letterhead: a full first page of any of the six layouts, and no more. */
export const HEADER_CHARS = 3000;

/**
 * A single brand marker in the BODY alone (weight 5) deliberately does not
 * clear this — that is the "counterparty named in a description" case. A brand
 * marker in the header (5 x 2 = 10) does, and so does brand + domain in the
 * body (5 + 5 = 10): a competitor's URL is not printed in a description.
 */
export const MIN_SCORE = 6;

/** The winner must beat the runner-up by this much, or the evidence is ambiguous. */
export const MARGIN = 4;

type BankMarker = { pattern: RegExp; weight: number; label: string };

type BankFingerprint = {
  profileId: Exclude<DetectedBankId, typeof UNKNOWN_BANK_ID>;
  bankName: string;
  markers: BankMarker[];
};

export type BankDetection = {
  profileId: DetectedBankId;
  bankName: string;
  confidence: number;
  reason: string;
  evidence: string[];
  scores: Record<string, number>;
};

/**
 * The detection as it travels to the accounting worker — snake_case to match
 * the worker's ProcessRequest fields (workers/accounting_worker/main.py).
 *
 * Every field is always sent, including an `unknown` verdict: the worker needs
 * to know that this side looked and found nothing, which is different from an
 * older frontend that did not look at all (those fields arrive as null).
 */
export type BankDetectionHints = {
  detected_bank: DetectedBankId;
  detected_bank_name: string;
  detected_bank_confidence: number;
  detected_bank_reason: string;
  detected_bank_evidence: string[];
};

export const BANK_FINGERPRINTS: BankFingerprint[] = [
  {
    profileId: "fnb_business_v1",
    bankName: "FNB South Africa",
    markers: [
      { pattern: /\bfirst national bank\b/, weight: 5, label: "first national bank" },
      { pattern: /\bfnb\b/, weight: 5, label: "fnb" },
      { pattern: /\bfnb\.co\.za\b/, weight: 5, label: "fnb.co.za" },
      { pattern: /\bfirstrand bank\b/, weight: 4, label: "firstrand bank" },
      { pattern: /\bplatinum business account\b/, weight: 3, label: "platinum business account" },
      { pattern: /\btransactions in rand\b/, weight: 3, label: "fnb transaction section heading" },
    ],
  },
  {
    profileId: "standard_bank_business_v1",
    bankName: "Standard Bank",
    markers: [
      { pattern: /\bstandard bank\b/, weight: 5, label: "standard bank" },
      { pattern: /\bstandardbank\.co\.za\b/, weight: 5, label: "standardbank.co.za" },
      { pattern: /\bstandard bank of south africa\b/, weight: 3, label: "standard bank of south africa" },
    ],
  },
  {
    profileId: "absa_business_v1",
    bankName: "ABSA",
    markers: [
      { pattern: /\babsa\b/, weight: 5, label: "absa" },
      { pattern: /\babsa\.co\.za\b/, weight: 5, label: "absa.co.za" },
      { pattern: /\babsa bank limited\b/, weight: 3, label: "absa bank limited" },
    ],
  },
  {
    profileId: "nedbank_business_v1",
    bankName: "Nedbank",
    markers: [
      { pattern: /\bnedbank\b/, weight: 5, label: "nedbank" },
      { pattern: /\bnedbank\.co\.za\b/, weight: 5, label: "nedbank.co.za" },
      { pattern: /\bnedbank limited\b/, weight: 3, label: "nedbank limited" },
    ],
  },
  {
    profileId: "capitec_business_v1",
    bankName: "Capitec",
    markers: [
      { pattern: /\bcapitec\b/, weight: 5, label: "capitec" },
      { pattern: /\bcapitecbank\.co\.za\b/, weight: 5, label: "capitecbank.co.za" },
      { pattern: /\bcapitec bank limited\b/, weight: 3, label: "capitec bank limited" },
    ],
  },
  {
    profileId: "investec_business_v1",
    bankName: "Investec",
    markers: [
      { pattern: /\binvestec\b/, weight: 5, label: "investec" },
      { pattern: /\binvestec\.co\.za\b/, weight: 5, label: "investec.co.za" },
      { pattern: /\binvestec bank limited\b/, weight: 3, label: "investec bank limited" },
    ],
  },
];

/**
 * Lowercase and collapse whitespace so markers match across layouts. OCR and
 * PDF extraction break a letterhead across lines and pad it with non-breaking
 * spaces; "STANDARD\n  BANK" and "STANDARD BANK" must score the same.
 */
export function normaliseStatementText(text: string | null | undefined): string {
  return (text ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function scoreFingerprint(fingerprint: BankFingerprint, haystack: string, header: string) {
  let score = 0;
  const evidence: string[] = [];
  for (const marker of fingerprint.markers) {
    if (!marker.pattern.test(haystack)) continue;
    const inHeader = marker.pattern.test(header);
    score += inHeader ? marker.weight * 2 : marker.weight;
    evidence.push(inHeader ? `${marker.label} (header)` : marker.label);
  }
  return { score, evidence };
}

/**
 * Share of the total evidence held by the winner, mapped onto 55..99.
 * Unopposed evidence scores 99 (never 100 — detection is evidence, not proof).
 * A dead heat would score 55 but cannot reach here: it fails MARGIN first.
 */
function confidenceFor(best: number, runnerUp: number): number {
  const total = best + runnerUp;
  if (total <= 0) return 0;
  const share = best / total;
  const value = Math.min(99, 55 + 88 * (share - 0.5));
  return Math.floor(value * 100 + 0.5) / 100;
}

function unknown(reason: string, scores: Record<string, number>): BankDetection {
  return { profileId: UNKNOWN_BANK_ID, bankName: UNKNOWN_BANK_NAME, confidence: 0, reason, evidence: [], scores };
}

/**
 * Identify the issuing bank from statement text alone. Returns `unknown` when
 * the evidence is absent or ambiguous — there is no default bank, because
 * routing an unidentified statement to a bank-specific parser is exactly the
 * defect this module exists to remove.
 */
export function detectBankFromText(text: string | null | undefined): BankDetection {
  const haystack = normaliseStatementText(text);
  if (!haystack) return unknown("no_text", {});

  const header = haystack.slice(0, HEADER_CHARS);
  const scores: Record<string, number> = {};
  const evidenceByProfile: Record<string, string[]> = {};

  for (const fingerprint of BANK_FINGERPRINTS) {
    const { score, evidence } = scoreFingerprint(fingerprint, haystack, header);
    if (score > 0) {
      scores[fingerprint.profileId] = score;
      evidenceByProfile[fingerprint.profileId] = evidence;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return unknown("no_bank_markers_found", scores);

  const [bestProfile, bestScore] = ranked[0];
  const runnerUpScore = ranked.length > 1 ? ranked[1][1] : 0;

  if (bestScore < MIN_SCORE) return unknown(`weak_evidence:${bestProfile}=${bestScore}<${MIN_SCORE}`, scores);
  if (bestScore - runnerUpScore < MARGIN) {
    return unknown(`ambiguous:${bestProfile}=${bestScore},runner_up=${runnerUpScore}`, scores);
  }

  const fingerprint = BANK_FINGERPRINTS.find((item) => item.profileId === bestProfile)!;
  return {
    profileId: fingerprint.profileId,
    bankName: fingerprint.bankName,
    confidence: confidenceFor(bestScore, runnerUpScore),
    reason: "matched_bank_markers",
    evidence: evidenceByProfile[bestProfile],
    scores,
  };
}

/**
 * Shape a detection for the accounting worker payload. `scores` is deliberately
 * left behind — it is diagnostic detail for this side's logs, not part of the
 * contract the worker consumes.
 */
export function bankDetectionHints(detection: BankDetection): BankDetectionHints {
  return {
    detected_bank: detection.profileId,
    detected_bank_name: detection.bankName,
    detected_bank_confidence: detection.confidence,
    detected_bank_reason: detection.reason,
    detected_bank_evidence: detection.evidence,
  };
}

// Pure document-type resolution, kept out of extractDocument.ts so it can be
// unit tested without pulling in next/headers via the Supabase server client.
import type { DocumentType } from "@/lib/types";

export type TypeEvidence = {
  /** The model's classification, when AI extraction ran. */
  aiType?: DocumentType | null;
  /** classifyDocumentText's verdict over the extracted text. */
  textType?: DocumentType | null;
};

/**
 * Resolve the document type WITHOUT fabricating one.
 *
 * This once defaulted every unclassified document to "bank_statement", which
 * mislabelled every invoice and contract. Then, until 2026-10-08, it could only
 * ever answer "bank_statement" or "unknown": the AI extraction schema asked for
 * statement fields only and nothing classified anything else, so a document
 * headed TAX INVOICE came back "unknown".
 *
 * Order: an already-known type is preserved; then the model's classification;
 * then real statement evidence (transaction rows AND a balance); then the
 * text classifier, which answers only when one type clearly leads. Otherwise
 * "unknown", which keeps the generic acceptance policy.
 */
export function resolveDetectedType(
  current: DocumentType | undefined,
  lineItemCount: number,
  openingBalance: number | null,
  closingBalance: number | null,
  evidence: TypeEvidence = {},
): DocumentType {
  if (current && current !== "unknown") return current;
  if (evidence.aiType && evidence.aiType !== "unknown") return evidence.aiType;
  const hasStatementEvidence = lineItemCount > 0 && (openingBalance != null || closingBalance != null);
  if (hasStatementEvidence) return "bank_statement";
  if (evidence.textType && evidence.textType !== "unknown") return evidence.textType;
  return "unknown";
}

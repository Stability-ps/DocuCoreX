// Pure document-type resolution, kept out of extractDocument.ts so it can be
// unit tested without pulling in next/headers via the Supabase server client.
import type { DocumentType } from "@/lib/types";

/**
 * Resolve the document type WITHOUT fabricating one.
 *
 * This previously defaulted every unclassified document to "bank_statement",
 * and that value was written straight back to `documents.detected_type`. It
 * mislabelled every invoice/contract/ID and — once the acceptance policy became
 * type-aware — flipped them onto the statement policy on the next run,
 * escalating a clean digital document through both OCR engines for nothing.
 *
 * An already-known type is always preserved. An unknown one is only called a
 * bank statement when the extraction produced real statement evidence:
 * transaction rows AND at least one balance. Otherwise it stays "unknown",
 * which is honest and keeps the generic acceptance policy.
 */
export function resolveDetectedType(
  current: DocumentType | undefined,
  lineItemCount: number,
  openingBalance: number | null,
  closingBalance: number | null,
): DocumentType {
  if (current && current !== "unknown") return current;
  const hasStatementEvidence = lineItemCount > 0 && (openingBalance != null || closingBalance != null);
  return hasStatementEvidence ? "bank_statement" : "unknown";
}

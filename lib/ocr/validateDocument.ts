// Type-aware deterministic validation. Bank statements are reconciled from
// their balances (validate.ts); that check means nothing for an invoice, which
// has no opening or closing balance, so before 2026-10-08 every invoice was
// "Failed — No transactions were extracted" or "Review Required" whatever its
// quality, and its confidence was the statement-weighted capture score. Here an
// invoice, receipt or purchase order is checked against its own arithmetic.
import type { DocumentType } from "@/lib/types";
import type { ValidationStatus } from "@/lib/ocr/validate";

export const COMMERCIAL_TYPES: ReadonlySet<DocumentType> = new Set(["invoice", "receipt", "purchase_order"]);

export type CommercialInput = {
  documentNumber: string | null | undefined;
  documentDate: string | null | undefined;
  issuerName: string | null | undefined;
  subtotal: number | null | undefined;
  taxAmount: number | null | undefined;
  totalAmount: number | null | undefined;
  lineAmounts: Array<number | null | undefined>;
  toleranceZar?: number;
};

export type DocumentValidation = {
  status: ValidationStatus;
  /** 0..100 — share of applicable checks that passed. */
  confidence: number;
  checks: Array<{ name: string; passed: boolean }>;
  reasons: string[];
};

const present = (value: unknown) => (typeof value === "string" ? value.trim().length > 0 : typeof value === "number" && Number.isFinite(value));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function validateCommercialDocument(input: CommercialInput): DocumentValidation {
  const tolerance = input.toleranceZar ?? 0.05;
  const checks: DocumentValidation["checks"] = [];
  const reasons: string[] = [];
  const check = (name: string, passed: boolean, reason: string) => {
    checks.push({ name, passed });
    if (!passed) reasons.push(reason);
  };

  check("total", present(input.totalAmount), "No total amount was found.");
  check("number", present(input.documentNumber), "No document number was found.");
  check("date", present(input.documentDate), "No document date was found.");
  check("issuer", present(input.issuerName), "No supplier/issuer was found.");

  const subtotal = present(input.subtotal) ? (input.subtotal as number) : null;
  const tax = present(input.taxAmount) ? (input.taxAmount as number) : null;
  const total = present(input.totalAmount) ? (input.totalAmount as number) : null;

  if (subtotal != null && tax != null && total != null) {
    const difference = round2(subtotal + tax - total);
    check("subtotal_plus_tax", Math.abs(difference) <= tolerance, `Subtotal ${subtotal.toFixed(2)} + tax ${tax.toFixed(2)} does not equal total ${total.toFixed(2)} (difference ${difference.toFixed(2)}).`);
  }

  const amounts = input.lineAmounts.filter((amount): amount is number => present(amount));
  if (amounts.length && (subtotal != null || total != null)) {
    const sum = round2(amounts.reduce((acc, amount) => acc + amount, 0));
    // Lines may be shown before tax (sum = subtotal) or tax-inclusive (sum = total).
    const matches = [subtotal, total].some((target) => target != null && Math.abs(sum - target) <= tolerance);
    check("line_items_sum", matches, `Line items sum to ${sum.toFixed(2)}, which matches neither the subtotal nor the total.`);
  }

  const passed = checks.filter((c) => c.passed).length;
  const confidence = Math.round((passed / checks.length) * 100);
  const status: ValidationStatus = total == null && !amounts.length ? "Failed" : reasons.length ? "Review Required" : "Ready";
  return { status, confidence, checks, reasons };
}

/**
 * For kinds with no arithmetic to check (financial statements, payslips, tax
 * documents, contracts, unknown), the honest status is "Review Required" and
 * the confidence reflects how much of the identifying header was found.
 */
export function validateUncheckedDocument(type: DocumentType, header: { issuerName?: string | null; documentDate?: string | null; documentNumber?: string | null }): DocumentValidation {
  const checks = [
    { name: "issuer", passed: present(header.issuerName) },
    { name: "date", passed: present(header.documentDate) },
    { name: "number", passed: present(header.documentNumber) },
  ];
  const confidence = Math.round((checks.filter((c) => c.passed).length / checks.length) * 100);
  return {
    status: "Review Required",
    confidence,
    checks,
    reasons: [`No automatic check exists for ${type === "unknown" ? "an unclassified document" : type.replace(/_/g, " ")}; review the extracted fields.`],
  };
}

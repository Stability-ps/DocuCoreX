// Deterministic validation of extracted figures. LLM/OCR output is NEVER trusted
// as-is: totals are recomputed from line items and reconciled against the
// declared opening/closing balances. Produces the benchmark's validation column.

export type ValidationStatus = "Ready" | "Review Required" | "Failed";

export type ValidatableLineItem = { debit?: number | null; credit?: number | null };

export type ValidationInput = {
  openingBalance: number | null | undefined;
  closingBalance: number | null | undefined;
  lineItems: ValidatableLineItem[];
  /** Absolute rand tolerance for reconciliation (rounding noise). */
  toleranceZar?: number;
};

export type ValidationResult = {
  status: ValidationStatus;
  totalDebits: number;
  totalCredits: number;
  computedClosing: number | null;
  reconciliationDifference: number | null;
  reasons: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sumField(items: ValidatableLineItem[], field: "debit" | "credit"): number {
  return round2(items.reduce((total, item) => total + Math.abs(Number(item[field] ?? 0)), 0));
}

// VAT on a VAT-inclusive amount at the SA standard rate (15/115).
export function vatInclusive(amount: number, ratePct = 15): number {
  return round2((amount * ratePct) / (100 + ratePct));
}

export function validateExtraction(input: ValidationInput): ValidationResult {
  const tolerance = input.toleranceZar ?? 0.05;
  const totalDebits = sumField(input.lineItems, "debit");
  const totalCredits = sumField(input.lineItems, "credit");
  const reasons: string[] = [];

  const hasOpening = typeof input.openingBalance === "number";
  const hasClosing = typeof input.closingBalance === "number";

  if (!input.lineItems.length) {
    return {
      status: "Failed",
      totalDebits,
      totalCredits,
      computedClosing: null,
      reconciliationDifference: null,
      reasons: ["No transactions were extracted."],
    };
  }

  if (!hasOpening || !hasClosing) {
    reasons.push("Opening and/or closing balance is missing — cannot reconcile.");
    return {
      status: "Review Required",
      totalDebits,
      totalCredits,
      computedClosing: null,
      reconciliationDifference: null,
      reasons,
    };
  }

  const computedClosing = round2((input.openingBalance as number) + totalCredits - totalDebits);
  const difference = round2(computedClosing - (input.closingBalance as number));

  if (Math.abs(difference) <= tolerance) {
    return { status: "Ready", totalDebits, totalCredits, computedClosing, reconciliationDifference: 0, reasons };
  }

  reasons.push(
    `Reconciliation mismatch: computed closing ${computedClosing.toFixed(2)} vs declared ${(input.closingBalance as number).toFixed(2)} (difference ${difference.toFixed(2)}).`,
  );
  return { status: "Review Required", totalDebits, totalCredits, computedClosing, reconciliationDifference: difference, reasons };
}

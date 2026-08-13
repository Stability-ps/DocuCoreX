/**
 * VAT types and the return position.
 *
 * No server imports — the browser and the tests both use this.
 *
 * TWO VAT FIGURES EXIST IN THIS PRODUCT AND THEY ARE NOT THE SAME THING.
 *
 * The VAT Working Paper in lib/accounting/export.ts estimates VAT as 15/115 of
 * bank-statement amounts. It is a useful working paper over source data and its
 * own header says it is an estimate.
 *
 * This module reports VAT that was POSTED — an amount an accountant entered
 * against an explicit tax code, sitting in a control account in the ledger. It
 * is the accounting record. The estimate is not.
 *
 * They will differ, often. Presenting either as the other would be the whole
 * failure this programme exists to prevent, so nothing here reads a bank
 * transaction or applies a rate to anything.
 */

export type TaxDirection = "output" | "input" | "none";

export type VatSummaryRow = {
  taxCodeId: string;
  code: string;
  name: string;
  direction: TaxDirection;
  rate: number;
  isCapital: boolean;
  vat201Box: string | null;
  /** False when the code has no control account, so its VAT cannot be located. */
  controlAccountMapped: boolean;
  netAmount: number;
  vatAmount: number;
  postingCount: number;
};

export type VatRegisterRow = {
  postingId: string;
  postingDate: string;
  code: string;
  direction: TaxDirection;
  accountCode: string;
  accountName: string;
  description: string | null;
  journalReference: string | null;
  sourceTransactionId: string | null;
  amount: number;
  isControlLeg: boolean;
};

export type VatPosition = {
  outputVat: number;
  inputVat: number;
  /** Positive: payable to SARS. Negative: refundable. */
  netVat: number;
  payable: boolean;
  /** Codes used in the period that have no control account, so their VAT is unlocatable. */
  unmappedCodes: string[];
};

/**
 * The net VAT position for a period.
 *
 * Summed in cents. A VAT return is filed to the cent, and a position that is
 * "about right" is a position that gets amended.
 */
export function vatPosition(rows: VatSummaryRow[]): VatPosition {
  const cents = (value: number) => Math.round(value * 100);
  let output = 0;
  let input = 0;
  const unmapped: string[] = [];

  for (const row of rows) {
    if (!row.controlAccountMapped && row.direction !== "none") unmapped.push(row.code);
    if (row.direction === "output") output += cents(row.vatAmount);
    if (row.direction === "input") input += cents(row.vatAmount);
  }

  return {
    outputVat: output / 100,
    inputVat: input / 100,
    netVat: (output - input) / 100,
    payable: output - input >= 0,
    unmappedCodes: unmapped,
  };
}

export type VatReadinessCheck = {
  label: string;
  state: "ok" | "blocked";
  detail?: string;
};

/**
 * Whether the period's VAT figures are fit to file from.
 *
 * §16: a VAT return must not be presented as ready until review checks pass.
 * These are checks the system can actually evaluate — a check it cannot compute
 * is absent rather than shown as passing.
 */
export function vatReadiness(input: {
  rows: VatSummaryRow[];
  position: VatPosition;
  transactionsAwaitingReview: number;
  periodLocked: boolean;
}): { checks: VatReadinessCheck[]; ready: boolean } {
  const checks: VatReadinessCheck[] = [];

  checks.push(
    input.rows.length
      ? { label: "VAT was posted in this period", state: "ok", detail: `${input.rows.length} tax ${input.rows.length === 1 ? "code" : "codes"} used` }
      : { label: "No VAT has been posted in this period", state: "blocked", detail: "A return cannot be prepared from an empty ledger" },
  );

  checks.push(
    input.position.unmappedCodes.length
      ? {
          label: `${input.position.unmappedCodes.length} tax ${input.position.unmappedCodes.length === 1 ? "code has" : "codes have"} no control account`,
          state: "blocked",
          detail: `${input.position.unmappedCodes.join(", ")} — their VAT cannot be located in the ledger`,
        }
      : { label: "Every tax code used has a control account", state: "ok" },
  );

  checks.push(
    input.transactionsAwaitingReview
      ? {
          label: `${input.transactionsAwaitingReview} transaction${input.transactionsAwaitingReview === 1 ? "" : "s"} still awaiting review`,
          state: "blocked",
          detail: "Unreviewed transactions may still change the period's VAT",
        }
      : { label: "No transactions are awaiting review", state: "ok" },
  );

  if (input.periodLocked) {
    checks.push({ label: "This VAT period is already filed and locked", state: "ok" });
  }

  return { checks, ready: checks.every((check) => check.state === "ok") };
}

export const DIRECTION_LABELS: Record<TaxDirection, string> = {
  output: "Output VAT (charged)",
  input: "Input VAT (incurred)",
  none: "No VAT arises",
};

export type VatBasis = "inclusive" | "exclusive";

/**
 * Split an amount into its taxable value and its VAT element.
 *
 * WHY THE BASIS IS ASKED FOR RATHER THAN GUESSED
 *
 * R1,000 at 15% is R869.57 + R130.43 if the amount includes VAT, and
 * R1,000 + R150.00 if it excludes it. Both are ordinary; nothing in the number
 * says which. A form that assumed one would silently mis-state one journal in
 * two, so the accountant states it.
 *
 * Computed in CENTS, and the VAT is derived by SUBTRACTION on the inclusive
 * basis so that net + VAT is exactly the amount entered. Rounding both halves
 * independently would produce a pair that does not add up to what the
 * accountant typed, and a journal that then fails to balance by a cent.
 */
export function splitVat(input: { amount: number; rate: number; basis: VatBasis }): { net: number; vat: number } {
  const amountCents = Math.round(input.amount * 100);
  if (input.rate <= 0 || amountCents === 0) return { net: input.amount, vat: 0 };

  if (input.basis === "inclusive") {
    const netCents = Math.round((amountCents * 100) / (100 + input.rate));
    return { net: netCents / 100, vat: (amountCents - netCents) / 100 };
  }

  const vatCents = Math.round((amountCents * input.rate) / 100);
  return { net: amountCents / 100, vat: vatCents / 100 };
}

/**
 * Accounts receivable and accounts payable: types and small pure helpers.
 *
 * No server imports — the browser and the tests both use this. Open items and
 * ageing are computed in the database (accounting_ar/ap_open_items,
 * accounting_ar/ap_ageing — migration 043), the same way the trial balance
 * and the VAT summary are: this module never re-derives a figure the database
 * already derived, it only formats and labels what comes back.
 */

export type Party = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  isActive: boolean;
};

export type OpenItem = {
  postingId: string;
  partyId: string;
  partyName: string;
  postingDate: string;
  dueDate: string | null;
  description: string | null;
  originalAmount: number;
  allocated: number;
  outstanding: number;
};

/** The other side of allocation: a receipt or payment with an unallocated remainder. */
export type UnallocatedPosting = {
  postingId: string;
  partyId: string;
  partyName: string;
  postingDate: string;
  description: string | null;
  originalAmount: number;
  allocated: number;
  remaining: number;
};

export type AgeingRow = {
  partyId: string;
  partyName: string;
  current: number;
  days30: number;
  days60: number;
  days90Plus: number;
  totalOutstanding: number;
};

export const AGEING_BUCKET_LABELS = ["Current", "1–30 days", "31–60 days", "60+ days"] as const;

/** Whichever of the two named dates governs ageing: due date if stated, posting date otherwise. */
export function ageingAnchorDate(item: Pick<OpenItem, "postingDate" | "dueDate">): string {
  return item.dueDate ?? item.postingDate;
}

/** Days overdue as at a given date. Negative means not yet due. */
export function daysOverdue(item: Pick<OpenItem, "postingDate" | "dueDate">, asAt: string): number {
  const anchor = ageingAnchorDate(item);
  const ms = Date.parse(`${asAt}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export function isOverdue(item: Pick<OpenItem, "postingDate" | "dueDate">, asAt: string): boolean {
  return daysOverdue(item, asAt) > 0;
}

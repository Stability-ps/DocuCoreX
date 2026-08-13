/**
 * Period close: types and the pure readiness logic.
 *
 * No server imports — the browser and the tests both use this.
 *
 * "Absence of a row means open" (migration 036): a period only exists here
 * once someone has closed it. There is deliberately no "open" status value —
 * open is the default, not a state anything writes.
 */

export type PeriodStatus = "soft_closed" | "locked";

export type AccountingPeriod = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: PeriodStatus;
  note: string | null;
  closedBy: string | null;
  closedAt: string;
};

export type PeriodReadiness = {
  unpostedJournalCount: number;
  openReconciliationCount: number;
  vatPeriodStatus: "submitted" | "locked" | null;
};

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  soft_closed: "Soft-closed",
  locked: "Locked",
};

/**
 * Why a lock would be refused, computed the same way the database decides it
 * (accounting_close_period, migration 041) so the UI can disable the Lock
 * action and explain itself before the round trip, not just after a 422.
 *
 * A soft close never has a reason to refuse — it carries no such requirement.
 */
export function lockBlockedReason(readiness: PeriodReadiness): string | null {
  if (readiness.unpostedJournalCount > 0) {
    const n = readiness.unpostedJournalCount;
    return `${n} unposted journal${n === 1 ? "" : "s"} dated in this period — post or remove ${n === 1 ? "it" : "them"} first.`;
  }
  return null;
}

/** Informational only: neither reconciliations nor VAT periods block a close. */
export function readinessNotes(readiness: PeriodReadiness): string[] {
  const notes: string[] = [];
  if (readiness.openReconciliationCount > 0) {
    const n = readiness.openReconciliationCount;
    notes.push(`${n} bank reconciliation${n === 1 ? "" : "s"} still in progress over this range.`);
  }
  if (readiness.vatPeriodStatus) {
    notes.push(`Overlaps a VAT period already ${readiness.vatPeriodStatus}.`);
  }
  return notes;
}

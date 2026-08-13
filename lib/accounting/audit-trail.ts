/**
 * The accounting audit trail: types and display labels over
 * accounting_audit_events (migration 041).
 *
 * No server imports — the browser and the tests both use this.
 *
 * Every row here was written by a database trigger, not by application code
 * choosing to log something. What the UI can do with it is read it; there is
 * no edit or delete affordance because there is no edit or delete path — the
 * table is append-only.
 */

export type AuditAction =
  | "journal_posted"
  | "journal_reversed"
  | "period_soft_closed"
  | "period_locked"
  | "period_reopened"
  | "reconciliation_completed"
  | "reconciliation_reopened"
  | "vat_period_submitted"
  | "vat_period_locked"
  | "vat_period_reopened";

export type AuditEntityType =
  | "accounting_journal"
  | "accounting_period"
  | "accounting_reconciliation"
  | "accounting_vat_period";

export type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue: unknown;
  newValue: unknown;
  metadata: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
};

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  journal_posted: "Journal posted",
  journal_reversed: "Journal reversed",
  period_soft_closed: "Period soft-closed",
  period_locked: "Period locked",
  period_reopened: "Period reopened",
  reconciliation_completed: "Reconciliation completed",
  reconciliation_reopened: "Reconciliation reopened",
  vat_period_submitted: "VAT period submitted",
  vat_period_locked: "VAT period locked",
  vat_period_reopened: "VAT period reopened",
};

export const AUDIT_ENTITY_LABELS: Record<AuditEntityType, string> = {
  accounting_journal: "Journal",
  accounting_period: "Accounting period",
  accounting_reconciliation: "Bank reconciliation",
  accounting_vat_period: "VAT period",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action as AuditAction] ?? action;
}

export function auditEntityLabel(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType as AuditEntityType] ?? entityType;
}

/** True for the events whose action reverses or unwinds an earlier one. */
export function isReversalAction(action: string): boolean {
  return action === "journal_reversed" || action === "period_reopened" || action === "reconciliation_reopened" || action === "vat_period_reopened";
}

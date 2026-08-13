/**
 * Period close data access.
 *
 * Closing and reopening are both delegated entirely to database functions
 * (accounting_close_period, accounting_reopen_period — migration 041). This
 * module never decides that a period may lock or reopen; duplicating that
 * judgment here would create a second opinion about when books may be closed.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { AccountingPeriod, PeriodReadiness, PeriodStatus } from "@/lib/accounting/period-close";

async function requireEntity(companyId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Entity not found in this workspace.");
  return context;
}

function mapPeriod(row: Record<string, unknown>): AccountingPeriod {
  return {
    id: String(row.id),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    status: row.status as PeriodStatus,
    note: (row.note as string | null) ?? null,
    closedBy: (row.closed_by as string | null) ?? null,
    closedAt: String(row.closed_at),
  };
}

export async function listAccountingPeriods(companyId: string): Promise<AccountingPeriod[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_periods")
    .select("*")
    .eq("company_id", companyId)
    .order("period_start", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapPeriod);
}

export async function getPeriodReadiness(companyId: string, from: string, to: string): Promise<PeriodReadiness> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .rpc("accounting_period_close_readiness", { target_company: companyId, from_date: from, to_date: to })
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    unpostedJournalCount: Number((data as Record<string, unknown> | null)?.unposted_journal_count ?? 0),
    openReconciliationCount: Number((data as Record<string, unknown> | null)?.open_reconciliation_count ?? 0),
    vatPeriodStatus: ((data as Record<string, unknown> | null)?.vat_period_status as PeriodReadiness["vatPeriodStatus"]) ?? null,
  };
}

export async function closeAccountingPeriod(input: {
  companyId: string;
  from: string;
  to: string;
  status: PeriodStatus;
  note?: string | null;
}): Promise<string> {
  const context = await requireEntity(input.companyId);
  const { data, error } = await context.supabase.rpc("accounting_close_period", {
    target_company: input.companyId,
    from_date: input.from,
    to_date: input.to,
    target_status: input.status,
    note_input: input.note ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function reopenAccountingPeriod(periodId: string, reason: string): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase.rpc("accounting_reopen_period", {
    target_period: periodId,
    reason,
  });
  if (error) throw new Error(error.message);
}

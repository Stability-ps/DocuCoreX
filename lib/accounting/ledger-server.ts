/**
 * Ledger reporting data access.
 *
 * Every function calls a database function that reads accounting_postings.
 * Nothing here aggregates in TypeScript, and nothing here reads
 * accounting_transactions — a report that consulted bank-statement categories
 * would not be a report of the books.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { LedgerRow, TrialBalanceRow } from "@/lib/accounting/ledger";

export type LedgerFilters = {
  companyId: string;
  from?: string | null;
  to?: string | null;
  accountId?: string | null;
  accountType?: string | null;
  journalType?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
};

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

export async function getGeneralLedger(filters: LedgerFilters): Promise<{ rows: LedgerRow[]; totalRows: number }> {
  const context = await requireEntity(filters.companyId);

  // Bounded server-side: the browser never receives the whole ledger. §35.
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  const { data, error } = await context.supabase.rpc("accounting_general_ledger", {
    target_company: filters.companyId,
    from_date: filters.from ?? null,
    to_date: filters.to ?? null,
    filter_account: filters.accountId ?? null,
    filter_account_type: filters.accountType ?? null,
    filter_journal_type: filters.journalType ?? null,
    search_text: filters.search ?? null,
    page_limit: limit,
    page_offset: Math.max(filters.offset ?? 0, 0),
  });

  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    postingId: String(row.posting_id),
    postingDate: String(row.posting_date),
    accountId: String(row.account_id),
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
    normalBalance: row.normal_balance as "debit" | "credit",
    journalId: String(row.journal_id),
    journalReference: (row.journal_reference as string | null) ?? null,
    journalType: String(row.journal_type),
    description: (row.description as string | null) ?? null,
    sourceTransactionId: (row.source_transaction_id as string | null) ?? null,
    sourceRunId: (row.source_run_id as string | null) ?? null,
    debit: Number(row.debit ?? 0),
    credit: Number(row.credit ?? 0),
    runningBalance: Number(row.running_balance ?? 0),
  }));

  // total_rows is the size of the whole filtered set, carried on every row by
  // the window function. Without it the UI cannot page, and taking rows.length
  // would say "100 entries" for every page of a ledger of any size.
  const totalRows = data?.length ? Number((data[0] as Record<string, unknown>).total_rows ?? 0) : 0;

  return { rows, totalRows };
}

export async function getTrialBalance(input: {
  companyId: string;
  from?: string | null;
  to?: string | null;
  includeAdjustments?: boolean;
}): Promise<TrialBalanceRow[]> {
  const context = await requireEntity(input.companyId);

  const { data, error } = await context.supabase.rpc("accounting_trial_balance", {
    target_company: input.companyId,
    from_date: input.from ?? null,
    to_date: input.to ?? null,
    include_adjustments: input.includeAdjustments ?? true,
  });

  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    accountId: String(row.account_id),
    code: String(row.code),
    name: String(row.name),
    accountType: String(row.account_type),
    normalBalance: row.normal_balance as "debit" | "credit",
    debits: Number(row.debits ?? 0),
    credits: Number(row.credits ?? 0),
    closingBalance: Number(row.closing_balance ?? 0),
    postingCount: Number(row.posting_count ?? 0),
  }));
}

export async function getAccountOpeningBalance(companyId: string, accountId: string, before: string | null): Promise<number> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_account_opening_balance", {
    target_company: companyId,
    target_account: accountId,
    before_date: before,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

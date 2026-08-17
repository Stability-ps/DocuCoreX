/**
 * Bank reconciliation data access.
 *
 * The ledger balance is always derived through accounting_bank_ledger_balance,
 * which reads postings. The statement balance is read from the statement run
 * that produced it. They are fetched separately and never substituted for one
 * another — a reconciliation exists because they differ.
 *
 * Nothing here writes to accounting_postings. A reconciliation that finds a
 * missing entry creates a JOURNAL and posts it through the gate.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type {
  BankAccountSummary,
  Reconciliation,
  ReconciliationItem,
  ReconciliationItemType,
  UnmatchedBankItem,
  UnmatchedLedgerEntry,
} from "@/lib/accounting/reconciliation";

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

/**
 * Bank accounts with both balances side by side.
 *
 * `statementBalance` is null when no statement is held for the period. That is
 * reported as its own status rather than as a zero — "we have no statement" and
 * "the statement says nil" are different facts, and only one of them means the
 * account is reconciled.
 */
export async function listBankAccounts(companyId: string, asAt: string): Promise<BankAccountSummary[]> {
  const context = await requireEntity(companyId);

  const { data: accounts, error } = await context.supabase
    .from("accounting_bank_accounts")
    .select("id, label, bank_name, account_number, ledger_account_id, accounting_accounts!accounting_bank_accounts_ledger_same_entity(code, name)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("label");

  if (error) throw new Error(error.message);

  const summaries: BankAccountSummary[] = [];

  for (const row of accounts ?? []) {
    const raw = (row as Record<string, unknown>).accounting_accounts;
    const account = (Array.isArray(raw) ? raw[0] : raw) as { code?: string; name?: string } | undefined;

    const { data: ledgerBalance, error: balanceError } = await context.supabase.rpc("accounting_bank_ledger_balance", {
      target_bank_account: row.id,
      as_at: asAt,
    });
    if (balanceError) throw new Error(balanceError.message);

    // The bank's own figure, from the latest statement covering the date.
    const { data: run } = await context.supabase
      .from("accounting_statement_runs")
      .select("closing_balance, statement_period_end")
      .eq("workspace_id", context.workspaceId)
      .eq("account_number", row.account_number ?? "")
      .lte("statement_period_end", asAt)
      .not("closing_balance", "is", null)
      .order("statement_period_end", { ascending: false })
      .limit(1)
      .maybeSingle();

    const statementBalance = run?.closing_balance === undefined || run?.closing_balance === null ? null : Number(run.closing_balance);
    const ledger = Number(ledgerBalance ?? 0);

    summaries.push({
      id: String(row.id),
      label: String(row.label),
      bankName: (row.bank_name as string | null) ?? null,
      accountNumber: (row.account_number as string | null) ?? null,
      ledgerAccountId: String(row.ledger_account_id),
      ledgerAccountCode: account?.code ?? "",
      ledgerAccountName: account?.name ?? "",
      statementBalance,
      statementDate: (run?.statement_period_end as string | null) ?? null,
      ledgerBalance: ledger,
      status:
        statementBalance === null
          ? "no_statement"
          : Math.round(statementBalance * 100) === Math.round(ledger * 100)
            ? "reconciled"
            : "review",
    });
  }

  return summaries;
}

/** Ledger accounts eligible to be a bank control account, for the mapping UI. */
export async function listMappableAccounts(companyId: string) {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_accounts")
    .select("id, code, name")
    .eq("company_id", companyId)
    .eq("account_type", "asset")
    .eq("is_active", true)
    .order("code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name) }));
}

export async function createBankAccountMapping(input: {
  companyId: string;
  label: string;
  bankName: string | null;
  accountNumber: string | null;
  ledgerAccountId: string;
}) {
  const context = await requireEntity(input.companyId);
  const { data: workspace } = await context.supabase
    .from("companies")
    .select("workspace_id")
    .eq("id", input.companyId)
    .single();

  const { data, error } = await context.supabase
    .from("accounting_bank_accounts")
    .insert({
      company_id: input.companyId,
      workspace_id: workspace?.workspace_id,
      label: input.label,
      bank_name: input.bankName,
      account_number: input.accountNumber,
      ledger_account_id: input.ledgerAccountId,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return String(data.id);
}

export async function getOrCreateReconciliation(input: {
  companyId: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<Reconciliation> {
  const context = await requireEntity(input.companyId);

  const { data: existing } = await context.supabase
    .from("accounting_reconciliations")
    .select("*")
    .eq("bank_account_id", input.bankAccountId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .maybeSingle();

  if (existing) return mapReconciliation(existing);

  const { data: workspace } = await context.supabase
    .from("companies").select("workspace_id").eq("id", input.companyId).single();

  const { data, error } = await context.supabase
    .from("accounting_reconciliations")
    .insert({
      company_id: input.companyId,
      workspace_id: workspace?.workspace_id,
      bank_account_id: input.bankAccountId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return mapReconciliation(data);
}

function mapReconciliation(row: Record<string, unknown>): Reconciliation {
  return {
    id: String(row.id),
    bankAccountId: String(row.bank_account_id),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    status: row.status as Reconciliation["status"],
    statementBalance: row.statement_balance === null ? null : Number(row.statement_balance),
    ledgerBalanceAtCompletion:
      row.ledger_balance_at_completion === null ? null : Number(row.ledger_balance_at_completion),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

export async function getReconciliationWorkspace(reconciliationId: string): Promise<{
  reconciliation: Reconciliation;
  ledgerBalance: number;
  items: ReconciliationItem[];
  unmatchedBank: UnmatchedBankItem[];
  unmatchedLedger: UnmatchedLedgerEntry[];
}> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");

  const { data: rec, error } = await context.supabase
    .from("accounting_reconciliations")
    .select("*, accounting_bank_accounts(ledger_account_id, account_number)")
    .eq("id", reconciliationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rec) throw new Error("Reconciliation not found.");

  const bankAccountRaw = (rec as Record<string, unknown>).accounting_bank_accounts;
  const bankAccount = (Array.isArray(bankAccountRaw) ? bankAccountRaw[0] : bankAccountRaw) as {
    ledger_account_id: string;
    account_number: string | null;
  };

  const { data: ledgerBalance } = await context.supabase.rpc("accounting_bank_ledger_balance", {
    target_bank_account: rec.bank_account_id,
    as_at: rec.period_end,
  });

  const { data: itemRows } = await context.supabase
    .from("accounting_reconciliation_items")
    .select("*")
    .eq("reconciliation_id", reconciliationId);

  const items: ReconciliationItem[] = (itemRows ?? []).map((row) => ({
    id: String(row.id),
    transactionId: (row.transaction_id as string | null) ?? null,
    postingId: (row.posting_id as string | null) ?? null,
    matchGroup: (row.match_group as string | null) ?? null,
    itemType: row.item_type as ReconciliationItemType,
    matchMethod: row.match_method as ReconciliationItem["matchMethod"],
    matchConfidence: row.match_confidence === null ? null : Number(row.match_confidence),
    resolvingJournalId: (row.resolving_journal_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  }));

  const claimedTransactions = new Set(items.map((item) => item.transactionId).filter(Boolean) as string[]);
  const claimedPostings = new Set(items.map((item) => item.postingId).filter(Boolean) as string[]);

  // Bank side: extracted transactions from statements for this account, in period.
  const { data: transactionRows } = await context.supabase
    .from("accounting_transactions")
    .select("id, transaction_date, description, debit_amount, credit_amount, run_id, accounting_statement_runs!inner(account_number)")
    .eq("workspace_id", context.workspaceId)
    .gte("transaction_date", rec.period_start)
    .lte("transaction_date", rec.period_end)
    .eq("accounting_statement_runs.account_number", bankAccount?.account_number ?? "");

  const unmatchedBank: UnmatchedBankItem[] = (transactionRows ?? [])
    .filter((row) => !claimedTransactions.has(String(row.id)))
    .map((row) => ({
      transactionId: String(row.id),
      date: String(row.transaction_date),
      description: String(row.description ?? ""),
      reference: null,
      // One signed amount: a debit on the bank statement reduces the account.
      amount: Number(row.debit_amount ?? 0) - Number(row.credit_amount ?? 0),
      runId: String(row.run_id),
    }));

  // Ledger side: postings to the mapped control account, in period.
  const { data: postingRows } = await context.supabase
    .from("accounting_postings")
    // accounting_postings has two FKs to accounting_journals (journal_id, plus
    // the composite same-entity check from migration 037) — hint the plain
    // journal_id relationship so PostgREST doesn't refuse the embed as ambiguous.
    .select("id, posting_date, description, debit, credit, accounting_journals!journal_id(reference)")
    .eq("company_id", rec.company_id)
    .eq("account_id", bankAccount?.ledger_account_id)
    .gte("posting_date", rec.period_start)
    .lte("posting_date", rec.period_end);

  const unmatchedLedger: UnmatchedLedgerEntry[] = (postingRows ?? [])
    .filter((row) => !claimedPostings.has(String(row.id)))
    .map((row) => {
      const journalRaw = (row as Record<string, unknown>).accounting_journals;
      const journal = (Array.isArray(journalRaw) ? journalRaw[0] : journalRaw) as { reference?: string | null } | undefined;
      return {
        postingId: String(row.id),
        date: String(row.posting_date),
        description: (row.description as string | null) ?? null,
        journalReference: journal?.reference ?? null,
        amount: Number(row.debit ?? 0) - Number(row.credit ?? 0),
      };
    });

  return {
    reconciliation: mapReconciliation(rec),
    ledgerBalance: Number(ledgerBalance ?? 0),
    items,
    unmatchedBank,
    unmatchedLedger,
  };
}

export async function recordReconciliationItems(input: {
  reconciliationId: string;
  companyId: string;
  entries: Array<{
    transactionId?: string | null;
    postingId?: string | null;
    itemType: ReconciliationItemType;
    matchGroup?: string | null;
    matchMethod?: "manual" | "auto" | "suggested";
    matchConfidence?: number | null;
    note?: string | null;
  }>;
}) {
  const context = await requireEntity(input.companyId);
  const { data: workspace } = await context.supabase
    .from("companies").select("workspace_id").eq("id", input.companyId).single();

  const { error } = await context.supabase.from("accounting_reconciliation_items").insert(
    input.entries.map((entry) => ({
      reconciliation_id: input.reconciliationId,
      company_id: input.companyId,
      workspace_id: workspace?.workspace_id,
      transaction_id: entry.transactionId ?? null,
      posting_id: entry.postingId ?? null,
      item_type: entry.itemType,
      match_group: entry.matchGroup ?? null,
      match_method: entry.matchMethod ?? "manual",
      match_confidence: entry.matchConfidence ?? null,
      note: entry.note ?? null,
    })),
  );
  if (error) throw new Error(error.message);
}

export async function removeReconciliationItem(itemId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase.from("accounting_reconciliation_items").delete().eq("id", itemId);
  if (error) throw new Error(error.message);
}

/**
 * Complete a reconciliation.
 *
 * Delegated entirely to the database function, which enforces that the
 * difference is EXPLAINED rather than merely zero, and refuses while any
 * missing posting is unresolved. Duplicating that rule here would create a
 * second opinion about when books may be signed off.
 */
export async function completeReconciliation(reconciliationId: string, statementBalance: number) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase.rpc("accounting_complete_reconciliation", {
    target_reconciliation: reconciliationId,
    statement_balance_input: statementBalance,
  });
  if (error) throw new Error(error.message);
}

export async function reopenReconciliation(reconciliationId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase
    .from("accounting_reconciliations")
    .update({ status: "reopened", updated_at: new Date().toISOString() })
    .eq("id", reconciliationId);
  if (error) throw new Error(error.message);
}

/**
 * Completed and in-progress reconciliations for an entity.
 *
 * History is read from the reconciliation records themselves, including the
 * balances stored at completion. Those are deliberately NOT re-derived: a
 * completed reconciliation is a statement of what was agreed on a date, and
 * recomputing it from today's ledger would quietly rewrite it whenever a later
 * journal touched the period.
 */
export async function listReconciliationHistory(companyId: string) {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_reconciliations")
    .select("id, period_start, period_end, status, statement_balance, ledger_balance_at_completion, completed_at, accounting_bank_accounts(label)")
    .eq("company_id", companyId)
    .order("period_end", { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const raw = (row as Record<string, unknown>).accounting_bank_accounts;
    const account = (Array.isArray(raw) ? raw[0] : raw) as { label?: string } | undefined;
    const statement = row.statement_balance === null ? null : Number(row.statement_balance);
    const ledger = row.ledger_balance_at_completion === null ? null : Number(row.ledger_balance_at_completion);
    return {
      id: String(row.id),
      bankAccountLabel: account?.label ?? "Bank account",
      periodStart: String(row.period_start),
      periodEnd: String(row.period_end),
      status: String(row.status) as "in_progress" | "completed" | "reopened",
      statementBalance: statement,
      ledgerBalanceAtCompletion: ledger,
      // Recorded, not recomputed. Null while a reconciliation is in progress.
      difference: statement === null || ledger === null ? null : statement - ledger,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  });
}

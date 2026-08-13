/**
 * Journals and the posting gate.
 *
 * The balance rule is enforced in the DATABASE (migration 036,
 * accounting_post_journal). It is checked again here, and again in the browser,
 * for one reason only: to tell the accountant what is wrong before they submit.
 * None of those checks is the control. If this file and the database ever
 * disagree, the database is right and this is a bug — which is why posting goes
 * through the RPC rather than inserting postings directly.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import { validateJournalLines } from "@/lib/accounting/journals";
import type { JournalLineInput, JournalStatus, JournalSummary, JournalType } from "@/lib/accounting/journals";

export type { JournalLineInput, JournalStatus, JournalSummary, JournalType } from "@/lib/accounting/journals";

async function assertCompanyInWorkspace(companyId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");

  const { data, error } = await context.supabase
    .from("companies")
    .select("id, workspace_id")
    .eq("id", companyId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Entity not found in this workspace.");
  return { context, workspaceId: context.workspaceId };
}

export async function listJournals(companyId: string): Promise<JournalSummary[]> {
  const { context } = await assertCompanyInWorkspace(companyId);

  const { data, error } = await context.supabase
    .from("accounting_journals")
    .select(
      "id, company_id, journal_type, reference, journal_date, description, status, reverses_journal_id, posted_at, created_at, accounting_journal_lines(debit, credit)",
    )
    .eq("company_id", companyId)
    .order("journal_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const lines = (row as { accounting_journal_lines?: Array<{ debit: number; credit: number }> }).accounting_journal_lines ?? [];
    return {
      id: String(row.id),
      companyId: String(row.company_id),
      journalType: row.journal_type as JournalType,
      reference: (row.reference as string | null) ?? null,
      journalDate: String(row.journal_date),
      description: (row.description as string | null) ?? null,
      status: row.status as JournalStatus,
      reversesJournalId: (row.reverses_journal_id as string | null) ?? null,
      totalDebit: lines.reduce((total, line) => total + Number(line.debit ?? 0), 0),
      totalCredit: lines.reduce((total, line) => total + Number(line.credit ?? 0), 0),
      lineCount: lines.length,
      postedAt: (row.posted_at as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  });
}

/**
 * Create a journal and, optionally, post it in the same call.
 *
 * Posting goes through accounting_post_journal rather than inserting postings
 * here. That is the difference between a rule and a habit: the RPC is the only
 * way into the ledger, so nothing — not this file, not a future import, not a
 * console session — can add a posting that skipped the balance check.
 */
export async function createJournal(input: {
  companyId: string;
  journalType: JournalType;
  reference: string | null;
  journalDate: string;
  description: string | null;
  lines: JournalLineInput[];
  post: boolean;
}): Promise<{ journalId: string; status: JournalStatus }> {
  const validation = validateJournalLines(input.lines);
  // A draft is allowed to be unbalanced — that is what a draft is for. Only
  // posting requires balance.
  if (input.post && validation.length) {
    throw new Error(validation.map((issue) => (issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message)).join(" "));
  }

  const { context, workspaceId } = await assertCompanyInWorkspace(input.companyId);

  const { data: journal, error: journalError } = await context.supabase
    .from("accounting_journals")
    .insert({
      company_id: input.companyId,
      workspace_id: workspaceId,
      journal_type: input.journalType,
      reference: input.reference,
      journal_date: input.journalDate,
      description: input.description,
      status: "draft",
    })
    .select("id")
    .single();

  if (journalError) throw new Error(journalError.message);
  const journalId = String(journal.id);

  const { error: linesError } = await context.supabase.from("accounting_journal_lines").insert(
    input.lines.map((line, index) => ({
      journal_id: journalId,
      company_id: input.companyId,
      workspace_id: workspaceId,
      account_id: line.accountId,
      line_number: index + 1,
      debit: line.debit,
      credit: line.credit,
      description: line.description ?? null,
    })),
  );

  if (linesError) {
    // The journal header would otherwise survive with no lines, which reads as
    // a real but empty journal in every list.
    await context.supabase.from("accounting_journals").delete().eq("id", journalId);
    throw new Error(linesError.message);
  }

  if (!input.post) return { journalId, status: "draft" };

  const { error: postError } = await context.supabase.rpc("accounting_post_journal", { target_journal: journalId });
  if (postError) throw new Error(postError.message);

  return { journalId, status: "posted" };
}

export async function postJournal(journalId: string): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");

  const { error } = await context.supabase.rpc("accounting_post_journal", { target_journal: journalId });
  if (error) throw new Error(error.message);
}

export async function reverseJournal(journalId: string, reason: string | null): Promise<string> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");

  const { data, error } = await context.supabase.rpc("accounting_reverse_journal", {
    target_journal: journalId,
    reversal_date: null,
    reason,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/**
 * Bulk journal import data access.
 *
 * Every journal is posted through the SAME createJournal → accounting_post_journal
 * gate as a hand-typed one (journals-server.ts) — nothing here inserts into
 * accounting_postings, re-checks balance, or re-decides that a period is open.
 * Import is a bulk CLIENT of the existing gate, not a second one.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import { createJournal } from "@/lib/accounting/journals-server";
import { listChartOfAccounts } from "@/lib/accounting/chart-server";
import { listTaxCodes } from "@/lib/accounting/vat-server";
import { listCustomers, listSuppliers } from "@/lib/accounting/receivables-payables-server";
import {
  validateJournalImportRows,
  type JournalImportContext,
  type JournalImportOutcome,
  type JournalImportRow,
} from "@/lib/accounting/journal-import";

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

const key = (value: string) => value.trim().toLowerCase();

async function loadImportContext(companyId: string) {
  const context = await requireEntity(companyId);

  const [accounts, taxCodes, customers, suppliers, importedReferences] = await Promise.all([
    listChartOfAccounts(companyId),
    listTaxCodes(companyId),
    listCustomers(companyId),
    listSuppliers(companyId),
    context.supabase.from("accounting_journals").select("reference").eq("company_id", companyId).not("import_batch_id", "is", null),
  ]);

  if (importedReferences.error) throw new Error(importedReferences.error.message);

  const accountCodeToId = new Map(accounts.map((a) => [key(a.code), a.id]));
  const taxCodeToId = new Map(taxCodes.map((t) => [key(t.code), t.id]));
  const customerNameToId = new Map(customers.map((c) => [key(c.name), c.id]));
  const supplierNameToId = new Map(suppliers.map((s) => [key(s.name), s.id]));
  const alreadyImportedReferences = new Set(
    (importedReferences.data ?? []).map((row) => key(String(row.reference ?? ""))).filter(Boolean),
  );

  const importContext: JournalImportContext = {
    accountCodes: new Set(accountCodeToId.keys()),
    taxCodes: new Set(taxCodeToId.keys()),
    customerNames: new Set(customerNameToId.keys()),
    supplierNames: new Set(supplierNameToId.keys()),
    alreadyImportedReferences,
  };

  return { context, accountCodeToId, taxCodeToId, customerNameToId, supplierNameToId, importContext };
}

export async function previewJournalImport(companyId: string, rows: JournalImportRow[]): Promise<JournalImportOutcome[]> {
  const { importContext } = await loadImportContext(companyId);
  return validateJournalImportRows(rows, importContext);
}

export type JournalImportCommitResult = {
  batchId: string;
  outcomes: JournalImportOutcome[];
  postedCount: number;
  failedCount: number;
};

export async function commitJournalImport(input: { companyId: string; filename: string; rows: JournalImportRow[] }): Promise<JournalImportCommitResult> {
  const { context, accountCodeToId, taxCodeToId, customerNameToId, supplierNameToId, importContext } = await loadImportContext(input.companyId);
  const outcomes = validateJournalImportRows(input.rows, importContext);
  const valid = outcomes.filter((o): o is Extract<JournalImportOutcome, { status: "valid" }> => o.status === "valid");

  // Runtime failures (the posting gate refuses for a reason this validator
  // doesn't model — a period locked since preview, a race on the reference
  // uniqueness index) reclassify a group from valid to failed. They never
  // undo a journal that already posted, and never touch a different group.
  const failed: Array<{ reference: string; rowNumbers: number[]; message: string }> = outcomes
    .filter((o) => o.status === "error")
    .map((o) => ({ reference: o.reference, rowNumbers: o.rowNumbers, message: o.messages.join(" ") }));
  const postedJournalIds: string[] = [];

  for (const group of valid) {
    try {
      const { journalId } = await createJournal({
        companyId: input.companyId,
        journalType: group.journalType,
        reference: group.reference,
        journalDate: group.journalDate,
        description: group.description,
        dueDate: group.dueDate,
        lines: group.lines.map((line) => ({
          accountId: accountCodeToId.get(key(line.accountCode)) as string,
          debit: line.debit,
          credit: line.credit,
          taxCodeId: line.taxCode ? (taxCodeToId.get(key(line.taxCode)) ?? null) : null,
          customerId: line.customerName ? (customerNameToId.get(key(line.customerName)) ?? null) : null,
          supplierId: line.supplierName ? (supplierNameToId.get(key(line.supplierName)) ?? null) : null,
        })),
        post: true,
      });
      postedJournalIds.push(journalId);
    } catch (error) {
      failed.push({ reference: group.reference, rowNumbers: group.rowNumbers, message: error instanceof Error ? error.message : "Unable to post this journal." });
    }
  }

  const { data: batch, error: batchError } = await context.supabase
    .from("accounting_import_batches")
    .insert({
      company_id: input.companyId,
      workspace_id: context.workspaceId,
      import_type: "journals",
      filename: input.filename,
      total_groups: outcomes.length,
      valid_groups: postedJournalIds.length,
      rejected_groups: failed.length,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (batchError) throw new Error(batchError.message);
  const batchId = String(batch.id);

  if (postedJournalIds.length) {
    const { error } = await context.supabase.from("accounting_journals").update({ import_batch_id: batchId }).in("id", postedJournalIds);
    if (error) throw new Error(error.message);
  }

  if (failed.length) {
    const { error } = await context.supabase.from("accounting_import_batch_errors").insert(
      failed.map((f) => ({
        batch_id: batchId,
        company_id: input.companyId,
        workspace_id: context.workspaceId,
        group_reference: f.reference || null,
        row_numbers: f.rowNumbers,
        message: f.message,
      })),
    );
    if (error) throw new Error(error.message);
  }

  return { batchId, outcomes, postedCount: postedJournalIds.length, failedCount: failed.length };
}

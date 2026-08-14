/**
 * Chart of accounts import: data access.
 *
 * Preview and commit both call validateCoaImportRows against a FRESH read of
 * the chart — commit never trusts a client-supplied "this row was valid"
 * flag from an earlier preview call. Only commit writes anything, and only
 * for rows that re-validate as new or updated; a row that fails is never
 * partially applied.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import { listChartOfAccounts } from "@/lib/accounting/chart-server";
import { validateCoaImportRows, type CoaImportOutcome, type CoaImportRow } from "@/lib/accounting/coa-import";

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

export async function previewCoaImport(companyId: string, rows: CoaImportRow[]): Promise<CoaImportOutcome[]> {
  await requireEntity(companyId);
  const existing = await listChartOfAccounts(companyId);
  return validateCoaImportRows(rows, existing);
}

export type CoaImportCommitResult = {
  batchId: string;
  outcomes: CoaImportOutcome[];
  createdCount: number;
  updatedCount: number;
  failedCount: number;
};

export async function commitCoaImport(input: { companyId: string; filename: string; rows: CoaImportRow[] }): Promise<CoaImportCommitResult> {
  const context = await requireEntity(input.companyId);
  const existing = await listChartOfAccounts(input.companyId);
  const codeToId = new Map(existing.map((a) => [a.code.trim().toLowerCase(), a.id]));

  const outcomes = validateCoaImportRows(input.rows, existing);
  const writable = outcomes.filter((o): o is Extract<CoaImportOutcome, { status: "new" | "updated" }> => o.status === "new" || o.status === "updated");

  // Runtime failures (a race since the read above, a constraint this
  // validator doesn't know about) reclassify a row from writable to failed —
  // they never abort rows that already succeeded.
  const failed: Array<{ rowNumber: number; code: string | null; message: string }> = outcomes
    .filter((o) => o.status === "error")
    .map((o) => ({ rowNumber: o.rowNumber, code: o.code, message: o.message }));
  let createdCount = 0;
  let updatedCount = 0;
  const writtenAccountIds: string[] = [];

  // Accounts are written FIRST, batchless. The batch row is append-only and
  // must state the true outcome, which isn't known until every write has
  // been attempted — so it's created last, with final counts, and the
  // written accounts are linked to it in a follow-up update rather than at
  // insert time. This is also what keeps a batch row that failed to link
  // from ever existing: linking happens only after the batch itself exists.
  for (const outcome of writable) {
    const row = outcome.row;
    const parentId = row.parentCode ? (codeToId.get(row.parentCode.trim().toLowerCase()) ?? null) : null;

    if (outcome.status === "new") {
      const { data, error } = await context.supabase
        .from("accounting_accounts")
        .insert({
          company_id: input.companyId,
          workspace_id: context.workspaceId,
          code: row.code,
          name: row.name,
          account_type: row.accountType,
          normal_balance: row.normalBalance,
          parent_id: parentId,
          vat_default: row.vatDefault,
          description: row.description,
        })
        .select("id")
        .single();
      if (error) {
        failed.push({ rowNumber: row.rowNumber, code: row.code, message: error.message });
      } else {
        createdCount += 1;
        writtenAccountIds.push(String(data.id));
      }
    } else {
      const { data, error } = await context.supabase
        .from("accounting_accounts")
        .update({
          name: row.name,
          vat_default: row.vatDefault,
          description: row.description,
          parent_id: parentId,
          updated_at: new Date().toISOString(),
        })
        .eq("company_id", input.companyId)
        .ilike("code", row.code)
        .select("id")
        .single();
      if (error) {
        failed.push({ rowNumber: row.rowNumber, code: row.code, message: error.message });
      } else {
        updatedCount += 1;
        writtenAccountIds.push(String(data.id));
      }
    }
  }

  const { data: batch, error: batchError } = await context.supabase
    .from("accounting_import_batches")
    .insert({
      company_id: input.companyId,
      workspace_id: context.workspaceId,
      import_type: "chart_of_accounts",
      filename: input.filename,
      total_groups: outcomes.length,
      valid_groups: createdCount + updatedCount,
      rejected_groups: failed.length,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (batchError) throw new Error(batchError.message);
  const batchId = String(batch.id);

  if (writtenAccountIds.length) {
    const { error } = await context.supabase.from("accounting_accounts").update({ import_batch_id: batchId }).in("id", writtenAccountIds);
    if (error) throw new Error(error.message);
  }

  if (failed.length) {
    const { error } = await context.supabase.from("accounting_import_batch_errors").insert(
      failed.map((f) => ({
        batch_id: batchId,
        company_id: input.companyId,
        workspace_id: context.workspaceId,
        group_reference: f.code,
        row_numbers: [f.rowNumber],
        message: f.message,
      })),
    );
    if (error) throw new Error(error.message);
  }

  return { batchId, outcomes, createdCount, updatedCount, failedCount: failed.length };
}

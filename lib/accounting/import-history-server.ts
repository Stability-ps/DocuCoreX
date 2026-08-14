/**
 * Import history data access. Read-only — accounting_import_batches and
 * accounting_import_batch_errors are append-only tables (migration 044);
 * there is no update or delete path to expose here.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { ImportBatch, ImportBatchError, ImportType } from "@/lib/accounting/import-history";

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

function mapBatch(row: Record<string, unknown>): ImportBatch {
  return {
    id: String(row.id),
    importType: row.import_type as ImportType,
    filename: String(row.filename),
    totalGroups: Number(row.total_groups),
    validGroups: Number(row.valid_groups),
    rejectedGroups: Number(row.rejected_groups),
    createdAt: String(row.created_at),
  };
}

export async function listImportBatches(companyId: string): Promise<ImportBatch[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_import_batches")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapBatch);
}

export async function getImportBatch(batchId: string): Promise<ImportBatch> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase.from("accounting_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Import batch not found.");
  return mapBatch(data);
}

export async function listImportBatchErrors(batchId: string): Promise<ImportBatchError[]> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase
    .from("accounting_import_batch_errors")
    .select("id, group_reference, row_numbers, message")
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    groupReference: (row.group_reference as string | null) ?? null,
    rowNumbers: (row.row_numbers as number[] | null) ?? [],
    message: String(row.message),
  }));
}

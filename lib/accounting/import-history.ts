/**
 * Import history: types and labels for browsing past chart-of-accounts and
 * journal import batches.
 *
 * No server imports — the browser and the tests both use this. A batch here
 * is read-only in every sense: the table it comes from is append-only
 * (migration 044), and there is no edit affordance because there is no edit
 * path.
 */

export type ImportType = "chart_of_accounts" | "journals";

export type ImportBatch = {
  id: string;
  importType: ImportType;
  filename: string;
  totalGroups: number;
  validGroups: number;
  rejectedGroups: number;
  createdAt: string;
};

export type ImportBatchError = {
  id: string;
  groupReference: string | null;
  rowNumbers: number[];
  message: string;
};

export const IMPORT_TYPE_LABELS: Record<ImportType, string> = {
  chart_of_accounts: "Chart of accounts",
  journals: "Journals",
};

export function importTypeLabel(importType: string): string {
  return IMPORT_TYPE_LABELS[importType as ImportType] ?? importType;
}

/** "Complete", "partial" (some rejected) or "failed" (nothing valid) — the one-word status a list view needs. */
export function importBatchStatus(batch: Pick<ImportBatch, "totalGroups" | "validGroups">): "complete" | "partial" | "failed" {
  if (batch.validGroups === batch.totalGroups) return "complete";
  if (batch.validGroups === 0) return "failed";
  return "partial";
}

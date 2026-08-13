/**
 * VAT data access.
 *
 * Reads accounting_vat_summary and accounting_vat_register, both of which
 * aggregate postings. No VAT FIGURE is derived from anything else, and no rate
 * is applied to anything — the legacy 15/115 estimate lives in export.ts and
 * stays there, clearly labelled as an estimate.
 *
 * One function does read accounting_transactions: countTransactionsAwaitingReview.
 * It counts rows and never reads an amount. That is a readiness signal — "the
 * period may still change" — and contributes to no monetary total. A test
 * asserts it stays the only such reference and that it stays a count.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { TaxDirection, VatRegisterRow, VatSummaryRow } from "@/lib/accounting/vat";

async function requireEntity(companyId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase
    .from("companies").select("id").eq("id", companyId)
    .eq("workspace_id", context.workspaceId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Entity not found in this workspace.");
  return context;
}

export async function getVatSummary(companyId: string, from: string, to: string): Promise<VatSummaryRow[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_vat_summary", {
    target_company: companyId, from_date: from, to_date: to,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    taxCodeId: String(row.tax_code_id),
    code: String(row.code),
    name: String(row.name),
    direction: row.direction as TaxDirection,
    rate: Number(row.rate ?? 0),
    isCapital: Boolean(row.is_capital),
    vat201Box: (row.vat201_box as string | null) ?? null,
    controlAccountMapped: Boolean(row.control_account_mapped),
    netAmount: Number(row.net_amount ?? 0),
    vatAmount: Number(row.vat_amount ?? 0),
    postingCount: Number(row.posting_count ?? 0),
  }));
}

export async function getVatRegister(
  companyId: string, from: string, to: string, limit = 500, offset = 0,
): Promise<{ rows: VatRegisterRow[]; totalRows: number }> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_vat_register", {
    target_company: companyId, from_date: from, to_date: to,
    page_limit: Math.min(Math.max(limit, 1), 1000), page_offset: Math.max(offset, 0),
  });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    postingId: String(row.posting_id),
    postingDate: String(row.posting_date),
    code: String(row.code),
    direction: row.direction as TaxDirection,
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
    description: (row.description as string | null) ?? null,
    journalReference: (row.journal_reference as string | null) ?? null,
    sourceTransactionId: (row.source_transaction_id as string | null) ?? null,
    amount: Number(row.amount ?? 0),
    isControlLeg: Boolean(row.is_control_leg),
  }));
  const totalRows = data?.length ? Number((data[0] as Record<string, unknown>).total_rows ?? 0) : 0;
  return { rows, totalRows };
}

export async function listTaxCodes(companyId: string) {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_tax_codes")
    .select("id, code, name, rate, direction, is_capital, vat201_box, control_account_id, suggested_for_treatment, is_active")
    .eq("company_id", companyId)
    .order("direction")
    .order("code");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    rate: Number(row.rate ?? 0),
    direction: row.direction as TaxDirection,
    isCapital: Boolean(row.is_capital),
    vat201Box: (row.vat201_box as string | null) ?? null,
    controlAccountMapped: row.control_account_id !== null,
    suggestedForTreatment: (row.suggested_for_treatment as string | null) ?? null,
    isActive: Boolean(row.is_active),
  }));
}

/** VAT periods already filed, so the UI can show a period as locked. */
export async function getVatPeriod(companyId: string, from: string, to: string) {
  const context = await requireEntity(companyId);
  const { data } = await context.supabase
    .from("accounting_vat_periods")
    .select("id, period_start, period_end, status, declared_output_vat, declared_input_vat")
    .eq("company_id", companyId)
    .lte("period_start", to)
    .gte("period_end", from)
    .maybeSingle();
  if (!data) return null;
  return {
    id: String(data.id),
    periodStart: String(data.period_start),
    periodEnd: String(data.period_end),
    status: String(data.status) as "submitted" | "locked",
    declaredOutputVat: data.declared_output_vat === null ? null : Number(data.declared_output_vat),
    declaredInputVat: data.declared_input_vat === null ? null : Number(data.declared_input_vat),
  };
}

/** How many extracted transactions in the window are still unreviewed. */
export async function countTransactionsAwaitingReview(from: string, to: string): Promise<number> {
  const context = await getWorkspaceContext();
  if (!context) return 0;
  const { count } = await context.supabase
    .from("accounting_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", context.workspaceId)
    .gte("transaction_date", from)
    .lte("transaction_date", to)
    .eq("review_status", "needs_review");
  return count ?? 0;
}

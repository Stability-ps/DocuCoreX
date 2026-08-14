/**
 * Accounts receivable and accounts payable data access.
 *
 * Allocation is delegated entirely to accounting_allocate_ar /
 * accounting_allocate_ap (migration 043), which own the validation — same
 * customer/supplier on both sides, both postings to the entity's control
 * account, amount within each side's unallocated remainder. This module
 * never re-decides any of that; duplicating it here would create a second
 * opinion about when an allocation may be recorded.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { AgeingRow, OpenItem, Party, UnallocatedPosting } from "@/lib/accounting/receivables-payables";

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

function mapParty(row: Record<string, unknown>): Party {
  return {
    id: String(row.id),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    isActive: Boolean(row.is_active),
  };
}

function mapOpenItem(row: Record<string, unknown>, partyKey: "customer" | "supplier"): OpenItem {
  return {
    postingId: String(row.posting_id),
    partyId: String(row[`${partyKey}_id`]),
    partyName: String(row[`${partyKey}_name`]),
    postingDate: String(row.posting_date),
    dueDate: (row.due_date as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    originalAmount: Number(row.original_amount),
    allocated: Number(row.allocated),
    outstanding: Number(row.outstanding),
  };
}

function mapAgeingRow(row: Record<string, unknown>, partyKey: "customer" | "supplier"): AgeingRow {
  return {
    partyId: String(row[`${partyKey}_id`]),
    partyName: String(row[`${partyKey}_name`]),
    current: Number(row.current_amount),
    days30: Number(row.days_30),
    days60: Number(row.days_60),
    days90Plus: Number(row.days_90_plus),
    totalOutstanding: Number(row.total_outstanding),
  };
}

function mapUnallocatedPosting(row: Record<string, unknown>, partyKey: "customer" | "supplier"): UnallocatedPosting {
  return {
    postingId: String(row.posting_id),
    partyId: String(row[`${partyKey}_id`]),
    partyName: String(row[`${partyKey}_name`]),
    postingDate: String(row.posting_date),
    description: (row.description as string | null) ?? null,
    originalAmount: Number(row.original_amount),
    allocated: Number(row.allocated),
    remaining: Number(row.remaining),
  };
}

/**
 * Control mapping, read alongside everything else so the UI can gate itself
 * on "is there one yet" before showing open items that have nowhere to post
 * against — same "control mapping first" ordering as bank reconciliation (039).
 */
export async function getControlAccounts(companyId: string): Promise<{ arControlAccountId: string | null; apControlAccountId: string | null }> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_entity_settings")
    .select("ar_control_account_id, ap_control_account_id")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    arControlAccountId: (data?.ar_control_account_id as string | null) ?? null,
    apControlAccountId: (data?.ap_control_account_id as string | null) ?? null,
  };
}

export async function setArControlAccount(companyId: string, accountId: string): Promise<void> {
  const context = await requireEntity(companyId);
  const { error } = await context.supabase
    .from("accounting_entity_settings")
    .update({ ar_control_account_id: accountId, updated_at: new Date().toISOString() })
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
}

export async function setApControlAccount(companyId: string, accountId: string): Promise<void> {
  const context = await requireEntity(companyId);
  const { error } = await context.supabase
    .from("accounting_entity_settings")
    .update({ ap_control_account_id: accountId, updated_at: new Date().toISOString() })
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);
}

export async function listCustomers(companyId: string): Promise<Party[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_customers")
    .select("*")
    .eq("company_id", companyId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapParty);
}

export async function listSuppliers(companyId: string): Promise<Party[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase
    .from("accounting_suppliers")
    .select("*")
    .eq("company_id", companyId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapParty);
}

export async function createCustomer(input: { companyId: string; name: string; email?: string | null; phone?: string | null; address?: string | null }): Promise<string> {
  const context = await requireEntity(input.companyId);
  const { data, error } = await context.supabase
    .from("accounting_customers")
    .insert({
      company_id: input.companyId,
      workspace_id: context.workspaceId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return String(data.id);
}

export async function createSupplier(input: { companyId: string; name: string; email?: string | null; phone?: string | null; address?: string | null }): Promise<string> {
  const context = await requireEntity(input.companyId);
  const { data, error } = await context.supabase
    .from("accounting_suppliers")
    .insert({
      company_id: input.companyId,
      workspace_id: context.workspaceId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return String(data.id);
}

export async function listArOpenItems(companyId: string, asAt?: string): Promise<OpenItem[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ar_open_items", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapOpenItem(row, "customer"));
}

export async function listApOpenItems(companyId: string, asAt?: string): Promise<OpenItem[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ap_open_items", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapOpenItem(row, "supplier"));
}

export async function listArAgeing(companyId: string, asAt?: string): Promise<AgeingRow[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ar_ageing", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapAgeingRow(row, "customer"));
}

export async function listApAgeing(companyId: string, asAt?: string): Promise<AgeingRow[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ap_ageing", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapAgeingRow(row, "supplier"));
}

export async function listArUnallocatedReceipts(companyId: string, asAt?: string): Promise<UnallocatedPosting[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ar_unallocated_receipts", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapUnallocatedPosting(row, "customer"));
}

export async function listApUnallocatedPayments(companyId: string, asAt?: string): Promise<UnallocatedPosting[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_ap_unallocated_payments", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: Record<string, unknown>) => mapUnallocatedPosting(row, "supplier"));
}

export async function allocateAr(input: { companyId: string; invoicePostingId: string; receiptPostingId: string; amount: number }): Promise<string> {
  const context = await requireEntity(input.companyId);
  const { data, error } = await context.supabase.rpc("accounting_allocate_ar", {
    invoice_posting: input.invoicePostingId,
    receipt_posting: input.receiptPostingId,
    amount: input.amount,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function allocateAp(input: { companyId: string; billPostingId: string; paymentPostingId: string; amount: number }): Promise<string> {
  const context = await requireEntity(input.companyId);
  const { data, error } = await context.supabase.rpc("accounting_allocate_ap", {
    bill_posting: input.billPostingId,
    payment_posting: input.paymentPostingId,
    amount: input.amount,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/**
 * Deallocation is a plain delete, unlike a posting — see migration 043: an
 * allocation is a judgment about existing postings, not an entry itself.
 */
export async function deallocateAr(allocationId: string): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase.from("accounting_ar_allocations").delete().eq("id", allocationId);
  if (error) throw new Error(error.message);
}

export async function deallocateAp(allocationId: string): Promise<void> {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { error } = await context.supabase.from("accounting_ap_allocations").delete().eq("id", allocationId);
  if (error) throw new Error(error.message);
}

import { getWorkspaceContext } from "@/lib/server-documents";
import { invoiceItems, invoices } from "@/lib/mock-repository";
import { calculateInvoiceSubtotal, calculateLineItemTotal, parseNumericInput } from "@/lib/invoice-utils";
import type { InvoiceItemRecord, InvoiceLineItemDraft, InvoiceRecord, InvoiceStatus, InvoiceWithItems } from "@/lib/types";

// Re-export the pure calculation helpers so existing server-side imports of
// "@/lib/invoices" keep working; client components should import "@/lib/invoice-utils" directly.
export {
  calculateInvoiceFinalTotal,
  calculateInvoiceSubtotal,
  calculateInvoiceVatAmount,
  calculateLineItemTotal,
  createEmptyInvoiceLineItem,
  formatCurrency,
  parseNumericInput,
} from "@/lib/invoice-utils";

// ---------------------------------------------------------------------------
// Row <-> record mapping (Supabase snake_case rows <-> camelCase records)
// ---------------------------------------------------------------------------

type InvoiceRow = {
  id: string;
  workspace_id: string;
  invoice_number: string;
  title: string | null;
  description: string | null;
  status: InvoiceStatus;
  client_name: string;
  client_email: string | null;
  client_phone: string | null;
  client_address: string | null;
  bank_details: string | null;
  notes_to_client: string | null;
  terms_and_conditions: string | null;
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  due_date: string | null;
  created_by: string | null;
  sent_at: string | null;
  paid_at: string | null;
  overdue_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

type InvoiceItemRow = {
  id: string;
  invoice_id: string;
  service_item: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  position: number;
  created_at: string;
};

function mapInvoiceRow(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    invoiceNumber: row.invoice_number,
    title: row.title,
    description: row.description,
    status: row.status,
    clientName: row.client_name,
    clientEmail: row.client_email,
    clientPhone: row.client_phone,
    clientAddress: row.client_address,
    bankDetails: row.bank_details,
    notesToClient: row.notes_to_client,
    termsAndConditions: row.terms_and_conditions,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discount_amount),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    amountPaid: Number(row.amount_paid),
    dueDate: row.due_date,
    createdBy: row.created_by,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    overdueAt: row.overdue_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvoiceItemRow(row: InvoiceItemRow): InvoiceItemRecord {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    serviceItem: row.service_item,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    lineTotal: Number(row.line_total),
    position: row.position,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Sequential invoice number generation (INV-<year>-NNNN, scoped per workspace)
// ---------------------------------------------------------------------------

async function generateInvoiceNumber(): Promise<string> {
  const currentYear = new Date().getFullYear();
  const prefix = `INV-${currentYear}-`;
  let nextNumber = 1;

  const context = await getWorkspaceContext();

  if (!context) {
    const matching = invoices.filter((invoice) => invoice.invoiceNumber.startsWith(prefix));
    const highestSuffix = matching.reduce((max, invoice) => {
      const suffix = Number(invoice.invoiceNumber.slice(prefix.length));
      return Number.isFinite(suffix) ? Math.max(max, suffix) : max;
    }, 0);
    nextNumber = highestSuffix + 1;
  } else {
    const { data } = await context.supabase
      .from("invoices")
      .select("invoice_number")
      .eq("workspace_id", context.workspaceId)
      .like("invoice_number", `${prefix}%`)
      .order("invoice_number", { ascending: false })
      .limit(1);

    const latest = (data as Array<{ invoice_number: string }> | null)?.[0];

    if (latest?.invoice_number) {
      const suffix = Number(latest.invoice_number.slice(prefix.length));
      if (Number.isFinite(suffix)) {
        nextNumber = suffix + 1;
      }
    }
  }

  return `${prefix}${String(nextNumber).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Dual-mode data functions (mock store fallback vs Supabase), mirroring the
// pattern used in lib/server-documents.ts.
// ---------------------------------------------------------------------------

export type CreateInvoiceInput = {
  title?: string | null;
  description?: string | null;
  status?: InvoiceStatus;
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientAddress?: string | null;
  bankDetails?: string | null;
  notesToClient?: string | null;
  termsAndConditions?: string | null;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: string | null;
  lineItems: InvoiceLineItemDraft[];
};

function statusTimestampField(status: InvoiceStatus): "sentAt" | "paidAt" | "overdueAt" | "cancelledAt" | null {
  switch (status) {
    case "issued":
      return "sentAt";
    case "paid":
      return "paidAt";
    case "overdue":
      return "overdueAt";
    case "cancelled":
      return "cancelledAt";
    default:
      return null;
  }
}

export async function listInvoices(): Promise<InvoiceRecord[]> {
  const context = await getWorkspaceContext();

  if (!context) {
    return [...invoices].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  const { data, error } = await context.supabase
    .from("invoices")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data as InvoiceRow[]).map(mapInvoiceRow);
}

export async function getInvoiceWithItems(id: string): Promise<InvoiceWithItems | null> {
  const context = await getWorkspaceContext();

  if (!context) {
    const invoice = invoices.find((candidate) => candidate.id === id);

    if (!invoice) {
      return null;
    }

    const items = invoiceItems.filter((item) => item.invoiceId === id).sort((a, b) => a.position - b.position);
    return { ...invoice, items };
  }

  const { data: invoiceData, error: invoiceError } = await context.supabase
    .from("invoices")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .single();

  if (invoiceError || !invoiceData) {
    return null;
  }

  const { data: itemsData, error: itemsError } = await context.supabase
    .from("invoice_items")
    .select("*")
    .eq("invoice_id", id)
    .order("position", { ascending: true });

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  return {
    ...mapInvoiceRow(invoiceData as InvoiceRow),
    items: (itemsData as InvoiceItemRow[]).map(mapInvoiceItemRow),
  };
}

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceWithItems> {
  const cleanedLineItems = input.lineItems.filter(
    (item) => item.serviceItem.trim() || parseNumericInput(item.unitPrice) > 0,
  );

  if (!cleanedLineItems.length) {
    throw new Error("At least one invoice line item is required.");
  }

  if (!input.clientName.trim()) {
    throw new Error("Client name is required.");
  }

  const status: InvoiceStatus = input.status ?? "draft";
  const taxRate = Number.isFinite(input.taxRate) ? Number(input.taxRate) : 0;
  const discountAmount = Number.isFinite(input.discountAmount) ? Number(input.discountAmount) : 0;

  // Server-side recomputation: never trust client-submitted totals.
  const subtotal = calculateInvoiceSubtotal(cleanedLineItems);
  const amountAfterDiscount = Math.max(subtotal - discountAmount, 0);
  const taxAmount = amountAfterDiscount * (taxRate / 100);
  const totalAmount = Math.max(amountAfterDiscount + taxAmount, 0);

  const invoiceNumber = await generateInvoiceNumber();
  const nowIso = new Date().toISOString();
  const timestampField = statusTimestampField(status);

  const context = await getWorkspaceContext();

  if (!context) {
    const invoiceId = `invoice_${Date.now()}`;
    const record: InvoiceRecord = {
      id: invoiceId,
      workspaceId: "workspace_demo",
      invoiceNumber,
      title: input.title?.trim() || null,
      description: input.description?.trim() || null,
      status,
      clientName: input.clientName.trim(),
      clientEmail: input.clientEmail?.trim() || null,
      clientPhone: input.clientPhone?.trim() || null,
      clientAddress: input.clientAddress?.trim() || null,
      bankDetails: input.bankDetails?.trim() || null,
      notesToClient: input.notesToClient?.trim() || null,
      termsAndConditions: input.termsAndConditions?.trim() || null,
      subtotal,
      discountAmount,
      taxRate,
      taxAmount,
      totalAmount,
      amountPaid: 0,
      dueDate: input.dueDate || null,
      createdBy: "user_demo",
      sentAt: timestampField === "sentAt" ? nowIso : null,
      paidAt: timestampField === "paidAt" ? nowIso : null,
      overdueAt: timestampField === "overdueAt" ? nowIso : null,
      cancelledAt: timestampField === "cancelledAt" ? nowIso : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const items: InvoiceItemRecord[] = cleanedLineItems.map((item, index) => ({
      id: `invoice_item_${Date.now()}_${index}`,
      invoiceId,
      serviceItem: item.serviceItem.trim(),
      quantity: parseNumericInput(item.quantity),
      unitPrice: parseNumericInput(item.unitPrice),
      lineTotal: calculateLineItemTotal(item),
      position: index,
      createdAt: nowIso,
    }));

    invoices.unshift(record);
    invoiceItems.push(...items);

    return { ...record, items };
  }

  const { data: invoiceData, error: invoiceError } = await context.supabase
    .from("invoices")
    .insert({
      workspace_id: context.workspaceId,
      invoice_number: invoiceNumber,
      title: input.title?.trim() || null,
      description: input.description?.trim() || null,
      status,
      client_name: input.clientName.trim(),
      client_email: input.clientEmail?.trim() || null,
      client_phone: input.clientPhone?.trim() || null,
      client_address: input.clientAddress?.trim() || null,
      bank_details: input.bankDetails?.trim() || null,
      notes_to_client: input.notesToClient?.trim() || null,
      terms_and_conditions: input.termsAndConditions?.trim() || null,
      subtotal,
      discount_amount: discountAmount,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      amount_paid: 0,
      due_date: input.dueDate || null,
      created_by: context.userId,
      ...(timestampField === "sentAt" ? { sent_at: nowIso } : {}),
      ...(timestampField === "paidAt" ? { paid_at: nowIso } : {}),
      ...(timestampField === "overdueAt" ? { overdue_at: nowIso } : {}),
      ...(timestampField === "cancelledAt" ? { cancelled_at: nowIso } : {}),
    })
    .select("*")
    .single();

  if (invoiceError || !invoiceData) {
    throw new Error(invoiceError?.message ?? "Unable to create invoice");
  }

  const itemsToInsert = cleanedLineItems.map((item, index) => ({
    invoice_id: invoiceData.id,
    service_item: item.serviceItem.trim(),
    quantity: parseNumericInput(item.quantity),
    unit_price: parseNumericInput(item.unitPrice),
    position: index,
  }));

  const { data: insertedItems, error: itemsError } = await context.supabase
    .from("invoice_items")
    .insert(itemsToInsert)
    .select("*")
    .order("position", { ascending: true });

  if (itemsError) {
    throw new Error(itemsError.message);
  }

  return {
    ...mapInvoiceRow(invoiceData as InvoiceRow),
    items: (insertedItems as InvoiceItemRow[]).map(mapInvoiceItemRow),
  };
}

export async function updateInvoiceStatus(id: string, status: InvoiceStatus): Promise<InvoiceRecord | null> {
  const nowIso = new Date().toISOString();
  const timestampField = statusTimestampField(status);
  const context = await getWorkspaceContext();

  if (!context) {
    const invoice = invoices.find((candidate) => candidate.id === id);

    if (!invoice) {
      return null;
    }

    invoice.status = status;
    invoice.updatedAt = nowIso;

    if (timestampField === "sentAt") invoice.sentAt = nowIso;
    if (timestampField === "paidAt") invoice.paidAt = nowIso;
    if (timestampField === "overdueAt") invoice.overdueAt = nowIso;
    if (timestampField === "cancelledAt") invoice.cancelledAt = nowIso;

    return invoice;
  }

  const patch: Record<string, unknown> = { status, updated_at: nowIso };

  if (timestampField === "sentAt") patch.sent_at = nowIso;
  if (timestampField === "paidAt") patch.paid_at = nowIso;
  if (timestampField === "overdueAt") patch.overdue_at = nowIso;
  if (timestampField === "cancelledAt") patch.cancelled_at = nowIso;

  const { data, error } = await context.supabase
    .from("invoices")
    .update(patch)
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) {
    return null;
  }

  return mapInvoiceRow(data as InvoiceRow);
}

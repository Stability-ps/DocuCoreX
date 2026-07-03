import { getWorkspaceContext } from "@/lib/server-documents";
import { invoiceItems, invoiceSequences, invoices } from "@/lib/mock-repository";
import { getCompany, nextCompanyInvoiceSequence } from "@/lib/companies";
import { calculateInvoiceSubtotal, calculateInvoiceVatAmount, calculateLineItemTotal, parseNumericInput } from "@/lib/invoice-utils";
import type {
  InvoiceItemRecord,
  InvoiceLineItemDraft,
  InvoicePaymentTerms,
  InvoiceRecord,
  InvoiceStatus,
  InvoiceVatType,
  InvoiceWithItems,
} from "@/lib/types";

// Re-export the pure calculation helpers so existing server-side imports of
// "@/lib/invoices" keep working; client components should import "@/lib/invoice-utils" directly.
export {
  calculateInvoiceFinalTotal,
  calculateInvoiceSubtotal,
  calculateInvoiceVatAmount,
  calculateLineItemTotal,
  calculateLineTotalInclVat,
  calculateLineVatAmount,
  createEmptyInvoiceLineItem,
  effectiveVatRate,
  formatCurrency,
  parseNumericInput,
  paymentTermsOptions,
  vatTypeOptions,
} from "@/lib/invoice-utils";

// ---------------------------------------------------------------------------
// Row <-> record mapping (Supabase snake_case rows <-> camelCase records)
// ---------------------------------------------------------------------------

type InvoiceRow = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  invoice_number: string;
  sequence_number: number | null;
  title: string | null;
  description: string | null;
  status: InvoiceStatus;
  currency: string;
  invoice_date: string;
  due_date: string | null;
  payment_terms: InvoicePaymentTerms;
  reference_number: string | null;
  internal_notes: string | null;
  client_name: string;
  client_company_name: string | null;
  client_contact_person: string | null;
  client_email: string | null;
  client_phone: string | null;
  client_address: string | null;
  client_postal_address: string | null;
  client_vat_number: string | null;
  client_registration_number: string | null;
  attention_to: string | null;
  purchase_order_number: string | null;
  client_reference: string | null;
  issuer_name: string | null;
  issuer_trading_name: string | null;
  issuer_email: string | null;
  issuer_phone: string | null;
  issuer_website: string | null;
  issuer_address: string | null;
  issuer_postal_address: string | null;
  issuer_vat_number: string | null;
  issuer_registration_number: string | null;
  logo_data_url: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  bank_swift: string | null;
  payment_reference: string | null;
  payment_instructions: string | null;
  bank_details: string | null;
  notes_to_client: string | null;
  terms_and_conditions: string | null;
  subtotal: number;
  discount_amount: number;
  shipping_amount: number;
  additional_charges: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
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
  vat_type: InvoiceVatType;
  vat_rate: number;
  position: number;
  created_at: string;
};

function mapInvoiceRow(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    invoiceNumber: row.invoice_number,
    sequenceNumber: row.sequence_number,
    title: row.title,
    description: row.description,
    status: row.status,
    currency: row.currency,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    paymentTerms: row.payment_terms,
    referenceNumber: row.reference_number,
    internalNotes: row.internal_notes,
    clientName: row.client_name,
    clientCompanyName: row.client_company_name,
    clientContactPerson: row.client_contact_person,
    clientEmail: row.client_email,
    clientPhone: row.client_phone,
    clientAddress: row.client_address,
    clientPostalAddress: row.client_postal_address,
    clientVatNumber: row.client_vat_number,
    clientRegistrationNumber: row.client_registration_number,
    attentionTo: row.attention_to,
    purchaseOrderNumber: row.purchase_order_number,
    clientReference: row.client_reference,
    issuerName: row.issuer_name,
    issuerTradingName: row.issuer_trading_name,
    issuerEmail: row.issuer_email,
    issuerPhone: row.issuer_phone,
    issuerWebsite: row.issuer_website,
    issuerAddress: row.issuer_address,
    issuerPostalAddress: row.issuer_postal_address,
    issuerVatNumber: row.issuer_vat_number,
    issuerRegistrationNumber: row.issuer_registration_number,
    logoDataUrl: row.logo_data_url,
    bankName: row.bank_name,
    bankAccountHolder: row.bank_account_holder,
    bankAccountNumber: row.bank_account_number,
    bankBranchCode: row.bank_branch_code,
    bankSwift: row.bank_swift,
    paymentReference: row.payment_reference,
    paymentInstructions: row.payment_instructions,
    bankDetails: row.bank_details,
    notesToClient: row.notes_to_client,
    termsAndConditions: row.terms_and_conditions,
    subtotal: Number(row.subtotal),
    discountAmount: Number(row.discount_amount),
    shippingAmount: Number(row.shipping_amount),
    additionalCharges: Number(row.additional_charges),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    amountPaid: Number(row.amount_paid),
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
    vatType: row.vat_type,
    vatRate: Number(row.vat_rate),
    position: row.position,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// True per-workspace sequential invoice numbering: INV-000001, INV-000002, ...
// Never derived from a database row id, never reset by calendar year, and
// independent per workspace (see migration 008_invoice_expanded_fields.sql).
// ---------------------------------------------------------------------------

async function nextInvoiceSequence(): Promise<number> {
  const context = await getWorkspaceContext();

  if (!context) {
    const current = invoiceSequences.workspace_demo ?? 1;
    invoiceSequences.workspace_demo = current + 1;
    return current;
  }

  const { data, error } = await context.supabase.rpc("next_invoice_sequence", { p_workspace_id: context.workspaceId });

  if (error || typeof data !== "number") {
    throw new Error(error?.message ?? "Unable to generate the next invoice number");
  }

  return data;
}

function formatInvoiceNumber(sequenceNumber: number): string {
  return `INV-${String(sequenceNumber).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Dual-mode data functions (mock store fallback vs Supabase), mirroring the
// pattern used in lib/server-documents.ts.
// ---------------------------------------------------------------------------

export type CreateInvoiceInput = {
  companyId?: string | null;
  title?: string | null;
  description?: string | null;
  status?: InvoiceStatus;
  currency?: string;
  invoiceDate?: string | null;
  dueDate?: string | null;
  paymentTerms?: InvoicePaymentTerms;
  referenceNumber?: string | null;
  internalNotes?: string | null;
  clientName: string;
  clientCompanyName?: string | null;
  clientContactPerson?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientAddress?: string | null;
  clientPostalAddress?: string | null;
  clientVatNumber?: string | null;
  clientRegistrationNumber?: string | null;
  attentionTo?: string | null;
  purchaseOrderNumber?: string | null;
  clientReference?: string | null;
  issuerName?: string | null;
  issuerTradingName?: string | null;
  issuerEmail?: string | null;
  issuerPhone?: string | null;
  issuerWebsite?: string | null;
  issuerAddress?: string | null;
  issuerPostalAddress?: string | null;
  issuerVatNumber?: string | null;
  issuerRegistrationNumber?: string | null;
  logoDataUrl?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  bankBranchCode?: string | null;
  bankSwift?: string | null;
  paymentReference?: string | null;
  paymentInstructions?: string | null;
  bankDetails?: string | null;
  notesToClient?: string | null;
  termsAndConditions?: string | null;
  discountAmount?: number;
  shippingAmount?: number;
  additionalCharges?: number;
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

  // When a company profile is selected, it is the single source of truth for the
  // issuer/bank snapshot fields — this is what lets editing a company profile later
  // never change historical invoices, while every new invoice picks up the latest
  // profile automatically (see supabase/migrations/009_company_profiles.sql).
  const company = input.companyId ? await getCompany(input.companyId) : null;

  if (input.companyId && !company) {
    throw new Error("Selected company profile was not found.");
  }

  if (company?.isArchived) {
    throw new Error("Selected company profile is archived. Choose an active company profile.");
  }

  const status: InvoiceStatus = input.status ?? "draft";
  const discountAmount = Number.isFinite(input.discountAmount) ? Number(input.discountAmount) : 0;
  const shippingAmount = Number.isFinite(input.shippingAmount) ? Number(input.shippingAmount) : 0;
  const additionalCharges = Number.isFinite(input.additionalCharges) ? Number(input.additionalCharges) : 0;

  // Server-side recomputation: never trust client-submitted totals. VAT is computed per
  // line item (exempt/zero-rated/standard/custom), not a single flat invoice-level rate.
  const subtotal = calculateInvoiceSubtotal(cleanedLineItems);
  const taxAmount = calculateInvoiceVatAmount(cleanedLineItems, String(discountAmount));
  const amountAfterDiscount = Math.max(subtotal - discountAmount, 0);
  const totalAmount = Math.max(amountAfterDiscount + taxAmount + shippingAmount + additionalCharges, 0);
  // Blended effective rate, kept only as a display convenience for legacy summaries.
  const taxRate = amountAfterDiscount > 0 ? Number(((taxAmount / amountAfterDiscount) * 100).toFixed(2)) : 0;

  // Every company profile has its own independent invoice sequence; invoices with no
  // selected company (legacy path) fall back to the workspace-level sequence.
  const sequenceNumber = company ? await nextCompanyInvoiceSequence(company.id) : await nextInvoiceSequence();
  const invoiceNumber = formatInvoiceNumber(sequenceNumber);
  const nowIso = new Date().toISOString();
  const invoiceDate = input.invoiceDate || nowIso.slice(0, 10);
  const paymentTerms = input.paymentTerms ?? (company?.defaultPaymentTerms as InvoicePaymentTerms | undefined) ?? "due_on_receipt";
  const currency = input.currency || company?.defaultCurrency || "ZAR";
  const notesToClient = input.notesToClient?.trim() || company?.defaultNotes || null;
  const termsAndConditions = input.termsAndConditions?.trim() || company?.defaultTerms || null;
  const timestampField = statusTimestampField(status);

  // Issuer/bank snapshot: always taken from the company profile when one is selected
  // (a client can never override the business's own identity/banking details), and
  // falls back to the manually-entered fields only for the legacy no-company path.
  const issuerName = company ? company.businessName : input.issuerName?.trim() || null;
  const issuerTradingName = company ? company.tradingName : input.issuerTradingName?.trim() || null;
  const issuerEmail = company ? company.email : input.issuerEmail?.trim() || null;
  const issuerPhone = company ? company.phone : input.issuerPhone?.trim() || null;
  const issuerWebsite = company ? company.website : input.issuerWebsite?.trim() || null;
  const issuerAddress = company ? company.physicalAddress : input.issuerAddress?.trim() || null;
  const issuerPostalAddress = company ? company.postalAddress : input.issuerPostalAddress?.trim() || null;
  const issuerVatNumber = company ? company.vatNumber : input.issuerVatNumber?.trim() || null;
  const issuerRegistrationNumber = company ? company.registrationNumber : input.issuerRegistrationNumber?.trim() || null;
  const logoDataUrl = company ? company.logoDataUrl : input.logoDataUrl || null;
  const bankName = company ? company.bankName : input.bankName?.trim() || null;
  const bankAccountHolder = company ? company.bankAccountHolder : input.bankAccountHolder?.trim() || null;
  const bankAccountNumber = company ? company.bankAccountNumber : input.bankAccountNumber?.trim() || null;
  const bankBranchCode = company ? company.bankBranchCode : input.bankBranchCode?.trim() || null;
  const bankSwift = company ? company.bankSwift : input.bankSwift?.trim() || null;
  const paymentReference = company ? company.paymentReference || invoiceNumber : input.paymentReference?.trim() || null;

  const context = await getWorkspaceContext();

  if (!context) {
    const invoiceId = `invoice_${Date.now()}`;
    const record: InvoiceRecord = {
      id: invoiceId,
      workspaceId: "workspace_demo",
      companyId: company?.id ?? null,
      invoiceNumber,
      sequenceNumber,
      title: input.title?.trim() || null,
      description: input.description?.trim() || null,
      status,
      currency,
      invoiceDate,
      dueDate: input.dueDate || null,
      paymentTerms,
      referenceNumber: input.referenceNumber?.trim() || null,
      internalNotes: input.internalNotes?.trim() || null,
      clientName: input.clientName.trim(),
      clientCompanyName: input.clientCompanyName?.trim() || null,
      clientContactPerson: input.clientContactPerson?.trim() || null,
      clientEmail: input.clientEmail?.trim() || null,
      clientPhone: input.clientPhone?.trim() || null,
      clientAddress: input.clientAddress?.trim() || null,
      clientPostalAddress: input.clientPostalAddress?.trim() || null,
      clientVatNumber: input.clientVatNumber?.trim() || null,
      clientRegistrationNumber: input.clientRegistrationNumber?.trim() || null,
      attentionTo: input.attentionTo?.trim() || null,
      purchaseOrderNumber: input.purchaseOrderNumber?.trim() || null,
      clientReference: input.clientReference?.trim() || null,
      issuerName,
      issuerTradingName,
      issuerEmail,
      issuerPhone,
      issuerWebsite,
      issuerAddress,
      issuerPostalAddress,
      issuerVatNumber,
      issuerRegistrationNumber,
      logoDataUrl,
      bankName,
      bankAccountHolder,
      bankAccountNumber,
      bankBranchCode,
      bankSwift,
      paymentReference,
      paymentInstructions: input.paymentInstructions?.trim() || null,
      bankDetails: input.bankDetails?.trim() || null,
      notesToClient,
      termsAndConditions,
      subtotal,
      discountAmount,
      shippingAmount,
      additionalCharges,
      taxRate,
      taxAmount,
      totalAmount,
      amountPaid: 0,
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
      vatType: item.vatType,
      vatRate: parseNumericInput(item.vatRate),
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
      company_id: company?.id ?? null,
      invoice_number: invoiceNumber,
      sequence_number: sequenceNumber,
      title: input.title?.trim() || null,
      description: input.description?.trim() || null,
      status,
      currency,
      invoice_date: invoiceDate,
      due_date: input.dueDate || null,
      payment_terms: paymentTerms,
      reference_number: input.referenceNumber?.trim() || null,
      internal_notes: input.internalNotes?.trim() || null,
      client_name: input.clientName.trim(),
      client_company_name: input.clientCompanyName?.trim() || null,
      client_contact_person: input.clientContactPerson?.trim() || null,
      client_email: input.clientEmail?.trim() || null,
      client_phone: input.clientPhone?.trim() || null,
      client_address: input.clientAddress?.trim() || null,
      client_postal_address: input.clientPostalAddress?.trim() || null,
      client_vat_number: input.clientVatNumber?.trim() || null,
      client_registration_number: input.clientRegistrationNumber?.trim() || null,
      attention_to: input.attentionTo?.trim() || null,
      purchase_order_number: input.purchaseOrderNumber?.trim() || null,
      client_reference: input.clientReference?.trim() || null,
      issuer_name: issuerName,
      issuer_trading_name: issuerTradingName,
      issuer_email: issuerEmail,
      issuer_phone: issuerPhone,
      issuer_website: issuerWebsite,
      issuer_address: issuerAddress,
      issuer_postal_address: issuerPostalAddress,
      issuer_vat_number: issuerVatNumber,
      issuer_registration_number: issuerRegistrationNumber,
      logo_data_url: logoDataUrl,
      bank_name: bankName,
      bank_account_holder: bankAccountHolder,
      bank_account_number: bankAccountNumber,
      bank_branch_code: bankBranchCode,
      bank_swift: bankSwift,
      payment_reference: paymentReference,
      payment_instructions: input.paymentInstructions?.trim() || null,
      bank_details: input.bankDetails?.trim() || null,
      notes_to_client: notesToClient,
      terms_and_conditions: termsAndConditions,
      subtotal,
      discount_amount: discountAmount,
      shipping_amount: shippingAmount,
      additional_charges: additionalCharges,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      amount_paid: 0,
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
    vat_type: item.vatType,
    vat_rate: parseNumericInput(item.vatRate),
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

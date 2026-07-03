import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { createInvoice, listInvoices } from "@/lib/invoices";
import type { InvoiceLineItemDraft, InvoicePaymentTerms, InvoiceStatus } from "@/lib/types";

const validStatuses: InvoiceStatus[] = ["draft", "issued", "paid", "overdue", "cancelled"];
const validPaymentTerms: InvoicePaymentTerms[] = ["due_on_receipt", "7_days", "14_days", "30_days", "60_days", "90_days"];

type CreateInvoiceBody = {
  companyId?: string;
  title?: string;
  description?: string;
  status?: string;
  currency?: string;
  invoiceDate?: string;
  dueDate?: string;
  paymentTerms?: string;
  referenceNumber?: string;
  purchaseOrderNumber?: string;
  internalNotes?: string;
  clientName?: string;
  clientCompanyName?: string;
  clientContactPerson?: string;
  clientEmail?: string;
  clientPhone?: string;
  clientAddress?: string;
  clientPostalAddress?: string;
  clientVatNumber?: string;
  clientRegistrationNumber?: string;
  attentionTo?: string;
  clientReference?: string;
  issuerName?: string;
  issuerTradingName?: string;
  issuerEmail?: string;
  issuerPhone?: string;
  issuerWebsite?: string;
  issuerAddress?: string;
  issuerPostalAddress?: string;
  issuerVatNumber?: string;
  issuerRegistrationNumber?: string;
  logoDataUrl?: string;
  bankName?: string;
  bankAccountHolder?: string;
  bankAccountNumber?: string;
  bankBranchCode?: string;
  bankSwift?: string;
  paymentReference?: string;
  paymentInstructions?: string;
  bankDetails?: string;
  notesToClient?: string;
  termsAndConditions?: string;
  discountAmount?: number;
  shippingAmount?: number;
  additionalCharges?: number;
  lineItems?: InvoiceLineItemDraft[];
};

export async function GET() {
  try {
    return NextResponse.json({ invoices: await listInvoices() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load invoices" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CreateInvoiceBody;

  if (!body.clientName?.trim()) {
    return NextResponse.json({ error: "Client name is required" }, { status: 400 });
  }

  if (!Array.isArray(body.lineItems) || !body.lineItems.length) {
    return NextResponse.json({ error: "At least one invoice line item is required" }, { status: 400 });
  }

  const maxLogoDataUrlLength = 400_000; // ~300KB base64, enough for a resized logo thumbnail

  if (body.logoDataUrl && body.logoDataUrl.length > maxLogoDataUrlLength) {
    return NextResponse.json({ error: "Logo image is too large. Use a smaller image." }, { status: 400 });
  }

  const status = validStatuses.includes(body.status as InvoiceStatus) ? (body.status as InvoiceStatus) : "draft";
  const paymentTerms = validPaymentTerms.includes(body.paymentTerms as InvoicePaymentTerms)
    ? (body.paymentTerms as InvoicePaymentTerms)
    : "due_on_receipt";

  try {
    const invoice = await createInvoice({
      companyId: body.companyId,
      title: body.title,
      description: body.description,
      status,
      currency: body.currency,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate,
      paymentTerms,
      referenceNumber: body.referenceNumber,
      purchaseOrderNumber: body.purchaseOrderNumber,
      internalNotes: body.internalNotes,
      clientName: body.clientName,
      clientCompanyName: body.clientCompanyName,
      clientContactPerson: body.clientContactPerson,
      clientEmail: body.clientEmail,
      clientPhone: body.clientPhone,
      clientAddress: body.clientAddress,
      clientPostalAddress: body.clientPostalAddress,
      clientVatNumber: body.clientVatNumber,
      clientRegistrationNumber: body.clientRegistrationNumber,
      attentionTo: body.attentionTo,
      clientReference: body.clientReference,
      issuerName: body.issuerName,
      issuerTradingName: body.issuerTradingName,
      issuerEmail: body.issuerEmail,
      issuerPhone: body.issuerPhone,
      issuerWebsite: body.issuerWebsite,
      issuerAddress: body.issuerAddress,
      issuerPostalAddress: body.issuerPostalAddress,
      issuerVatNumber: body.issuerVatNumber,
      issuerRegistrationNumber: body.issuerRegistrationNumber,
      logoDataUrl: body.logoDataUrl,
      bankName: body.bankName,
      bankAccountHolder: body.bankAccountHolder,
      bankAccountNumber: body.bankAccountNumber,
      bankBranchCode: body.bankBranchCode,
      bankSwift: body.bankSwift,
      paymentReference: body.paymentReference,
      paymentInstructions: body.paymentInstructions,
      bankDetails: body.bankDetails,
      notesToClient: body.notesToClient,
      termsAndConditions: body.termsAndConditions,
      discountAmount: body.discountAmount,
      shippingAmount: body.shippingAmount,
      additionalCharges: body.additionalCharges,
      lineItems: body.lineItems,
    });

    await recordAuditLog({
      action: "invoice_created",
      entityType: "invoice",
      entityId: invoice.id,
      metadata: { status: invoice.status, totalAmount: invoice.totalAmount, invoiceNumber: invoice.invoiceNumber },
    });

    return NextResponse.json({ invoice });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create invoice" }, { status: 400 });
  }
}

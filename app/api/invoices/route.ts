import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { createInvoice, listInvoices } from "@/lib/invoices";
import type { InvoiceLineItemDraft, InvoiceStatus } from "@/lib/types";

const validStatuses: InvoiceStatus[] = ["draft", "issued", "paid", "overdue", "cancelled"];

type CreateInvoiceBody = {
  title?: string;
  description?: string;
  status?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  clientAddress?: string;
  issuerName?: string;
  issuerEmail?: string;
  issuerPhone?: string;
  issuerAddress?: string;
  logoDataUrl?: string;
  bankDetails?: string;
  notesToClient?: string;
  termsAndConditions?: string;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: string;
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

  try {
    const invoice = await createInvoice({
      title: body.title,
      description: body.description,
      status,
      clientName: body.clientName,
      clientEmail: body.clientEmail,
      clientPhone: body.clientPhone,
      clientAddress: body.clientAddress,
      issuerName: body.issuerName,
      issuerEmail: body.issuerEmail,
      issuerPhone: body.issuerPhone,
      issuerAddress: body.issuerAddress,
      logoDataUrl: body.logoDataUrl,
      bankDetails: body.bankDetails,
      notesToClient: body.notesToClient,
      termsAndConditions: body.termsAndConditions,
      taxRate: body.taxRate,
      discountAmount: body.discountAmount,
      dueDate: body.dueDate,
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

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getInvoiceWithItems, updateInvoiceStatus } from "@/lib/invoices";
import type { InvoiceStatus } from "@/lib/types";

const validStatuses: InvoiceStatus[] = ["draft", "issued", "paid", "overdue", "cancelled"];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoiceWithItems(id);

  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  return NextResponse.json({ invoice });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { status?: string };

  if (!validStatuses.includes(body.status as InvoiceStatus)) {
    return NextResponse.json({ error: "A valid status is required" }, { status: 400 });
  }

  const status = body.status as InvoiceStatus;
  const invoice = await updateInvoiceStatus(id, status);

  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  await recordAuditLog({
    action: "invoice_status_updated",
    entityType: "invoice",
    entityId: id,
    metadata: { status },
  });

  return NextResponse.json({ invoice });
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Printer } from "lucide-react";
import { InvoicePreview } from "@/components/invoices/InvoicePreview";
import { formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceStatus, InvoiceWithItems } from "@/lib/types";

const statusOptions: InvoiceStatus[] = ["draft", "issued", "paid", "overdue", "cancelled"];

export function InvoiceDetail({ invoiceId }: { invoiceId: string }) {
  const [invoice, setInvoice] = useState<InvoiceWithItems | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    async function load() {
      const response = await fetch(`/api/invoices/${invoiceId}`);
      if (!response.ok) {
        setNotFound(true);
        return;
      }
      const data = (await response.json()) as { invoice: InvoiceWithItems };
      setInvoice(data.invoice);
    }

    void load();
  }, [invoiceId]);

  async function updateStatus(status: InvoiceStatus) {
    setIsUpdating(true);
    const response = await fetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (response.ok) {
      const data = (await response.json()) as { invoice: InvoiceWithItems };
      setInvoice((current) => (current ? { ...current, ...data.invoice } : current));
    }

    setIsUpdating(false);
  }

  // Opens the user's own mail client with a prefilled subject/body. This is an immediate,
  // zero-config stopgap — DocuCoreX has no transactional email provider configured today (no
  // Resend/SendGrid/SMTP integration exists in lib/). It does NOT send anything server-side.
  // TODO: replace with a real "send email" call once a transactional email provider is wired up
  // (e.g. via a lib/notifications.ts style helper), matching Acapolite's Supabase Edge Function
  // + template approach but using our own provider/credentials.
  function emailInvoice() {
    if (!invoice) return;

    const subject = `Invoice ${invoice.invoiceNumber} from ${invoice.issuerName || "us"}`;
    const body = [
      `Hi ${invoice.clientName || ""},`,
      "",
      `Please find your invoice ${invoice.invoiceNumber} summarized below:`,
      `Total due: ${formatCurrency(invoice.totalAmount, invoice.currency)}`,
      invoice.dueDate ? `Due date: ${invoice.dueDate}` : "",
      "",
      "A printable copy is attached — use \"Print / Save as PDF\" on the invoice page and attach the PDF before sending.",
    ]
      .filter(Boolean)
      .join("\n");

    const mailto = `mailto:${encodeURIComponent(invoice.clientEmail || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  }

  if (notFound) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <p className="text-sm font-semibold text-rose-600">Invoice not found.</p>
        <Link href="/invoices" className="mt-3 inline-flex text-sm font-semibold text-royal-700">
          Back to invoices
        </Link>
      </div>
    );
  }

  if (!invoice) {
    return <div className="p-4 sm:p-6 lg:p-8 text-sm text-slate-500">Loading invoice…</div>;
  }

  const lineItemDrafts: InvoiceLineItemDraft[] = invoice.items.map((item) => ({
    id: item.id,
    serviceItem: item.serviceItem,
    quantity: String(item.quantity),
    unitPrice: String(item.unitPrice),
    vatType: item.vatType,
    vatRate: String(item.vatRate),
  }));

  return (
    <div className="space-y-5 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/invoices" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-royal-700">
          <ArrowLeft className="h-4 w-4" />
          Back to invoices
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={invoice.status}
            disabled={isUpdating}
            onChange={(event) => void updateStatus(event.target.value as InvoiceStatus)}
            className="min-h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-royal-300"
          >
            {statusOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={emailInvoice}
            title="Opens your mail app with the invoice details prefilled — attach the printed PDF before sending."
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300"
          >
            <Mail className="h-3.5 w-3.5" />
            Email invoice
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-royal-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-royal-700"
          >
            <Printer className="h-3.5 w-3.5" />
            Print / Save as PDF
          </button>
        </div>
      </div>

      <div id="invoice-print-area">
        <InvoicePreview
          invoice={{
            invoiceNumber: invoice.invoiceNumber,
            title: invoice.title,
            description: invoice.description,
            status: invoice.status,
            currency: invoice.currency,
            invoiceDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            paymentTerms: invoice.paymentTerms,
            referenceNumber: invoice.referenceNumber,
            purchaseOrderNumber: invoice.purchaseOrderNumber,
            clientName: invoice.clientName,
            clientCompanyName: invoice.clientCompanyName,
            clientContactPerson: invoice.clientContactPerson,
            clientEmail: invoice.clientEmail,
            clientPhone: invoice.clientPhone,
            clientAddress: invoice.clientAddress,
            clientPostalAddress: invoice.clientPostalAddress,
            clientVatNumber: invoice.clientVatNumber,
            clientRegistrationNumber: invoice.clientRegistrationNumber,
            attentionTo: invoice.attentionTo,
            clientReference: invoice.clientReference,
            issuerName: invoice.issuerName,
            issuerTradingName: invoice.issuerTradingName,
            issuerEmail: invoice.issuerEmail,
            issuerPhone: invoice.issuerPhone,
            issuerWebsite: invoice.issuerWebsite,
            issuerAddress: invoice.issuerAddress,
            issuerVatNumber: invoice.issuerVatNumber,
            issuerRegistrationNumber: invoice.issuerRegistrationNumber,
            logoDataUrl: invoice.logoDataUrl,
            bankName: invoice.bankName,
            bankAccountHolder: invoice.bankAccountHolder,
            bankAccountNumber: invoice.bankAccountNumber,
            bankBranchCode: invoice.bankBranchCode,
            bankSwift: invoice.bankSwift,
            paymentReference: invoice.paymentReference,
            paymentInstructions: invoice.paymentInstructions,
            notesToClient: invoice.notesToClient,
            termsAndConditions: invoice.termsAndConditions,
            lineItems: lineItemDrafts,
            discountAmount: String(invoice.discountAmount),
            shippingAmount: String(invoice.shippingAmount),
            additionalCharges: String(invoice.additionalCharges),
            amountPaid: invoice.amountPaid,
          }}
        />
      </div>
    </div>
  );
}

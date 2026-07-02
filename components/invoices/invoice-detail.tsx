"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import { formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceStatus, InvoiceWithItems } from "@/lib/types";

const statusStyles: Record<InvoiceStatus, string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-600",
  issued: "border-royal-200 bg-royal-50 text-royal-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  overdue: "border-rose-200 bg-rose-50 text-rose-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-400",
};

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
  }));

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/invoices" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-royal-700">
          <ArrowLeft className="h-4 w-4" />
          Back to invoices
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={invoice.status}
            disabled={isUpdating}
            onChange={(event) => void updateStatus(event.target.value as InvoiceStatus)}
            className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-royal-300"
          >
            {statusOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700"
          >
            <Printer className="h-4 w-4" />
            Print / Save as PDF
          </button>
        </div>
      </div>

      <div id="invoice-print-area" className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-royal-700">Invoice</p>
            <h1 className="mt-1 text-2xl font-semibold text-navy-950">{invoice.invoiceNumber}</h1>
            {invoice.title ? <p className="mt-1 text-sm text-slate-600">{invoice.title}</p> : null}
          </div>
          <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusStyles[invoice.status]}`}>
            {invoice.status}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billed to</p>
            <p className="mt-1 font-semibold text-slate-900">{invoice.clientName}</p>
            {invoice.clientEmail ? <p className="text-sm text-slate-600">{invoice.clientEmail}</p> : null}
            {invoice.clientPhone ? <p className="text-sm text-slate-600">{invoice.clientPhone}</p> : null}
            {invoice.clientAddress ? <p className="text-sm text-slate-600">{invoice.clientAddress}</p> : null}
          </div>
          <div className="md:text-right">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Due date</p>
            <p className="mt-1 font-semibold text-slate-900">{invoice.dueDate ?? "No due date set"}</p>
          </div>
        </div>

        {invoice.description ? <p className="text-sm leading-6 text-slate-600">{invoice.description}</p> : null}

        <InvoiceLineItemsEditor items={lineItemDrafts} readOnly />

        <div className="ml-auto max-w-xs space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span className="font-semibold text-slate-900">{formatCurrency(invoice.subtotal)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Discount</span>
            <span className="font-semibold text-slate-900">-{formatCurrency(invoice.discountAmount)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>VAT ({invoice.taxRate}%)</span>
            <span className="font-semibold text-slate-900">{formatCurrency(invoice.taxAmount)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-950">
            <span>Total due</span>
            <span>{formatCurrency(invoice.totalAmount)}</span>
          </div>
        </div>

        {invoice.bankDetails ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Banking details</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{invoice.bankDetails}</p>
          </div>
        ) : null}

        {invoice.notesToClient ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{invoice.notesToClient}</p>
          </div>
        ) : null}

        {invoice.termsAndConditions ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Terms and conditions</p>
            <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{invoice.termsAndConditions}</p>
          </div>
        ) : null}
      </div>

      {/* TODO: wire real client email notifications on invoice creation / status change once a
          transactional email provider is configured. DocuCoreX currently only has the in-app
          `appStore.notifications` mock feed (lib/app-state.ts) — no outbound email delivery
          exists yet, unlike Acapolite's Supabase Edge Function + template email. */}
    </div>
  );
}

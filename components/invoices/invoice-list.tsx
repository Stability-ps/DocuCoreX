"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceRecord } from "@/lib/types";

const statusStyles: Record<InvoiceRecord["status"], string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-600",
  issued: "border-royal-200 bg-royal-50 text-royal-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  overdue: "border-rose-200 bg-rose-50 text-rose-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-400",
};

export function InvoiceList() {
  const [invoices, setInvoices] = useState<InvoiceRecord[] | null>(null);

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/invoices");
      if (!response.ok) {
        setInvoices([]);
        return;
      }
      const data = (await response.json()) as { invoices: InvoiceRecord[] };
      setInvoices(data.invoices);
    }

    void load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Link
          href="/invoices/new"
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700"
        >
          <Plus className="h-4 w-4" />
          New invoice
        </Link>
      </div>

      {invoices === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Loading invoices…</div>
      ) : invoices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
          <FileText className="mx-auto h-7 w-7 text-slate-300" />
          <p className="mt-3 font-semibold text-navy-950">No invoices yet</p>
          <p className="mt-1 text-sm text-slate-500">Create your first client invoice to get started.</p>
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-[1.2fr_1fr_0.7fr_0.7fr_0.6fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 max-lg:hidden">
            <span>Invoice</span>
            <span>Client</span>
            <span>Due date</span>
            <span>Total</span>
            <span>Status</span>
          </div>
          <div className="divide-y divide-slate-100">
            {invoices.map((invoice) => (
              <Link
                key={invoice.id}
                href={`/invoices/${invoice.id}`}
                className="grid gap-2 px-5 py-4 transition hover:bg-slate-50 lg:grid-cols-[1.2fr_1fr_0.7fr_0.7fr_0.6fr] lg:items-center"
              >
                <div>
                  <p className="font-semibold text-navy-950">{invoice.invoiceNumber}</p>
                  <p className="text-sm text-slate-500">{invoice.title || "Untitled invoice"}</p>
                </div>
                <p className="text-sm font-semibold text-slate-700">{invoice.clientName}</p>
                <p className="text-sm text-slate-600">{invoice.dueDate ?? "—"}</p>
                <p className="text-sm font-semibold text-navy-950">{formatCurrency(invoice.totalAmount, invoice.currency)}</p>
                <span className={`inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${statusStyles[invoice.status]}`}>
                  {invoice.status}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

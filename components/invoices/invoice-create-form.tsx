"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import {
  calculateInvoiceFinalTotal,
  calculateInvoiceSubtotal,
  calculateInvoiceVatAmount,
  createEmptyInvoiceLineItem,
  formatCurrency,
} from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceRecord, InvoiceStatus } from "@/lib/types";

const inputClassName =
  "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-royal-500 focus:ring-2 focus:ring-royal-100";
const labelClassName = "text-xs font-semibold uppercase tracking-wide text-slate-500";

export function InvoiceCreateForm() {
  const router = useRouter();
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taxRate, setTaxRate] = useState("15");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [bankDetails, setBankDetails] = useState("");
  const [notesToClient, setNotesToClient] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");
  const [status, setStatus] = useState<InvoiceStatus>("draft");
  const [lineItems, setLineItems] = useState<InvoiceLineItemDraft[]>([createEmptyInvoiceLineItem()]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const subtotal = useMemo(() => calculateInvoiceSubtotal(lineItems), [lineItems]);
  const vatAmount = useMemo(() => calculateInvoiceVatAmount(lineItems, taxRate, discountAmount), [lineItems, taxRate, discountAmount]);
  const totalAmount = useMemo(() => calculateInvoiceFinalTotal(lineItems, taxRate, discountAmount), [lineItems, taxRate, discountAmount]);

  async function submit() {
    setError("");

    if (!clientName.trim()) {
      setError("Client name is required.");
      return;
    }

    setIsSubmitting(true);

    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName,
        clientEmail,
        clientPhone,
        clientAddress,
        title,
        description,
        dueDate: dueDate || null,
        taxRate: Number(taxRate || 0),
        discountAmount: Number(discountAmount || 0),
        bankDetails,
        notesToClient,
        termsAndConditions,
        status,
        lineItems,
      }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Unable to create invoice.");
      setIsSubmitting(false);
      return;
    }

    const data = (await response.json()) as { invoice: InvoiceRecord };
    router.push(`/invoices/${data.invoice.id}`);
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Client details</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Client name</label>
            <input className={inputClassName} value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Acme Holdings" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Client email</label>
            <input className={inputClassName} type="email" value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="accounts@client.com" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Client phone</label>
            <input className={inputClassName} value={clientPhone} onChange={(event) => setClientPhone(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Due date</label>
            <input className={inputClassName} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className={labelClassName}>Client address</label>
            <input className={inputClassName} value={clientAddress} onChange={(event) => setClientAddress(event.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Invoice details</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Title</label>
            <input className={inputClassName} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Professional services" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Status</label>
            <select className={inputClassName} value={status} onChange={(event) => setStatus(event.target.value as InvoiceStatus)}>
              {(["draft", "issued", "paid", "overdue", "cancelled"] as InvoiceStatus[]).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className={labelClassName}>Description</label>
            <textarea className={`${inputClassName} min-h-24`} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <InvoiceLineItemsEditor items={lineItems} onChange={setLineItems} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Discount, tax &amp; totals</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Discount (R)</label>
            <input className={inputClassName} type="number" min="0" step="0.01" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>VAT rate (%)</label>
            <input className={inputClassName} type="number" min="0" step="0.01" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} />
          </div>
        </div>
        <div className="mt-5 space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span className="font-semibold text-slate-900">{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Discount</span>
            <span className="font-semibold text-slate-900">-{formatCurrency(Number(discountAmount || 0))}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>VAT</span>
            <span className="font-semibold text-slate-900">{formatCurrency(vatAmount)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-950">
            <span>Total due</span>
            <span>{formatCurrency(totalAmount)}</span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Bank details &amp; notes</h2>
        <div className="mt-4 grid gap-4">
          <div className="space-y-1.5">
            <label className={labelClassName}>Bank details (shown on invoice)</label>
            <textarea className={`${inputClassName} min-h-20`} value={bankDetails} onChange={(event) => setBankDetails(event.target.value)} placeholder="Bank name | Account number | Branch code" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Notes to client</label>
            <textarea className={`${inputClassName} min-h-20`} value={notesToClient} onChange={(event) => setNotesToClient(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Terms and conditions</label>
            <textarea className={`${inputClassName} min-h-20`} value={termsAndConditions} onChange={(event) => setTermsAndConditions(event.target.value)} />
          </div>
        </div>
      </section>

      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={submit}
          disabled={isSubmitting}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-royal-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:cursor-wait disabled:bg-slate-300"
        >
          {isSubmitting ? "Creating…" : "Create invoice"}
        </button>
      </div>
    </div>
  );
}

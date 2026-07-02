import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import { calculateInvoiceFinalTotal, calculateInvoiceSubtotal, calculateInvoiceVatAmount, formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceStatus } from "@/lib/types";

const statusStyles: Record<InvoiceStatus, string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-600",
  issued: "border-royal-200 bg-royal-50 text-royal-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  overdue: "border-rose-200 bg-rose-50 text-rose-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-400",
};

export type InvoicePreviewData = {
  invoiceNumber?: string | null;
  title?: string | null;
  description?: string | null;
  status: InvoiceStatus;
  clientName: string;
  clientEmail?: string | null;
  clientPhone?: string | null;
  clientAddress?: string | null;
  issuerName?: string | null;
  issuerEmail?: string | null;
  issuerPhone?: string | null;
  issuerAddress?: string | null;
  logoDataUrl?: string | null;
  bankDetails?: string | null;
  notesToClient?: string | null;
  termsAndConditions?: string | null;
  dueDate?: string | null;
  lineItems: InvoiceLineItemDraft[];
  taxRate: string;
  discountAmount: string;
};

/**
 * Shared read-only invoice layout: renders the dual "your business / client" header with an
 * optional logo, line items, totals, bank details and notes. Used both for the live preview in
 * the create form (before anything is saved) and for the saved invoice detail/print view.
 */
export function InvoicePreview({ invoice }: { invoice: InvoicePreviewData }) {
  const subtotal = calculateInvoiceSubtotal(invoice.lineItems);
  const vatAmount = calculateInvoiceVatAmount(invoice.lineItems, invoice.taxRate, invoice.discountAmount);
  const totalAmount = calculateInvoiceFinalTotal(invoice.lineItems, invoice.taxRate, invoice.discountAmount);
  const discountAmount = Number(invoice.discountAmount || 0);
  const taxRate = Number(invoice.taxRate || 0);

  return (
    <div className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          {invoice.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, not an optimizable static asset
            <img src={invoice.logoDataUrl} alt="Business logo" className="h-14 w-14 rounded-lg border border-slate-200 object-contain" />
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-royal-700">Invoice</p>
            <h1 className="mt-1 text-2xl font-semibold text-navy-950">{invoice.invoiceNumber || "Draft — number assigned on save"}</h1>
            {invoice.title ? <p className="mt-1 text-sm text-slate-600">{invoice.title}</p> : null}
          </div>
        </div>
        <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusStyles[invoice.status]}`}>
          {invoice.status}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">From</p>
          <p className="mt-1 font-semibold text-slate-900">{invoice.issuerName || "Your business name"}</p>
          {invoice.issuerEmail ? <p className="text-sm text-slate-600">{invoice.issuerEmail}</p> : null}
          {invoice.issuerPhone ? <p className="text-sm text-slate-600">{invoice.issuerPhone}</p> : null}
          {invoice.issuerAddress ? <p className="text-sm text-slate-600">{invoice.issuerAddress}</p> : null}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billed to</p>
          <p className="mt-1 font-semibold text-slate-900">{invoice.clientName || "Client name"}</p>
          {invoice.clientEmail ? <p className="text-sm text-slate-600">{invoice.clientEmail}</p> : null}
          {invoice.clientPhone ? <p className="text-sm text-slate-600">{invoice.clientPhone}</p> : null}
          {invoice.clientAddress ? <p className="text-sm text-slate-600">{invoice.clientAddress}</p> : null}
        </div>
      </div>

      <div className="md:text-right">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Due date</p>
        <p className="mt-1 font-semibold text-slate-900">{invoice.dueDate || "No due date set"}</p>
      </div>

      {invoice.description ? <p className="text-sm leading-6 text-slate-600">{invoice.description}</p> : null}

      <InvoiceLineItemsEditor items={invoice.lineItems} readOnly />

      <div className="ml-auto max-w-xs space-y-2 rounded-lg bg-slate-50 p-4 text-sm">
        <div className="flex justify-between text-slate-600">
          <span>Subtotal</span>
          <span className="font-semibold text-slate-900">{formatCurrency(subtotal)}</span>
        </div>
        <div className="flex justify-between text-slate-600">
          <span>Discount</span>
          <span className="font-semibold text-slate-900">-{formatCurrency(discountAmount)}</span>
        </div>
        <div className="flex justify-between text-slate-600">
          <span>VAT ({taxRate}%)</span>
          <span className="font-semibold text-slate-900">{formatCurrency(vatAmount)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-navy-950">
          <span>Total due</span>
          <span>{formatCurrency(totalAmount)}</span>
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
  );
}

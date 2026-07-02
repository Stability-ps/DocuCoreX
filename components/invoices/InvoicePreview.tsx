import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import { calculateInvoiceFinalTotal, calculateInvoiceSubtotal, calculateInvoiceVatAmount, formatCurrency, paymentTermsOptions } from "@/lib/invoice-utils";
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
  currency: string;
  invoiceDate?: string | null;
  dueDate?: string | null;
  paymentTerms: string;
  referenceNumber?: string | null;
  purchaseOrderNumber?: string | null;
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
  clientReference?: string | null;
  issuerName?: string | null;
  issuerTradingName?: string | null;
  issuerEmail?: string | null;
  issuerPhone?: string | null;
  issuerWebsite?: string | null;
  issuerAddress?: string | null;
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
  notesToClient?: string | null;
  termsAndConditions?: string | null;
  lineItems: InvoiceLineItemDraft[];
  discountAmount: string;
  shippingAmount?: string;
  additionalCharges?: string;
  amountPaid?: number;
};

const fieldLabel = "text-[11px] font-semibold uppercase tracking-wide text-slate-400";

/**
 * Shared read-only invoice layout: renders the "your business" and "client" blocks grouped
 * separately, invoice meta, line items, and the full totals breakdown. Used both for the live
 * preview in the create form (before anything is saved) and for the saved invoice detail/print
 * view — so both stay pixel-identical.
 */
export function InvoicePreview({ invoice }: { invoice: InvoicePreviewData }) {
  const subtotal = calculateInvoiceSubtotal(invoice.lineItems);
  const vatAmount = calculateInvoiceVatAmount(invoice.lineItems, invoice.discountAmount);
  const totalAmount = calculateInvoiceFinalTotal(invoice.lineItems, invoice.discountAmount, invoice.shippingAmount, invoice.additionalCharges);
  const discountAmount = Number(invoice.discountAmount || 0);
  const shippingAmount = Number(invoice.shippingAmount || 0);
  const additionalCharges = Number(invoice.additionalCharges || 0);
  const amountPaid = invoice.amountPaid ?? 0;
  const balanceDue = Math.max(totalAmount - amountPaid, 0);
  const paymentTermsLabel = paymentTermsOptions.find((option) => option.value === invoice.paymentTerms)?.label ?? invoice.paymentTerms;
  const hasBankDetails = invoice.bankName || invoice.bankAccountNumber || invoice.paymentReference;
  const normalizedClientName = invoice.clientName.trim().toLowerCase();
  const normalizedClientCompany = invoice.clientCompanyName?.trim().toLowerCase();
  const shouldShowClientCompany = Boolean(invoice.clientCompanyName && normalizedClientCompany !== normalizedClientName);

  return (
    <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {invoice.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL, not an optimizable static asset
            <img src={invoice.logoDataUrl} alt="Business logo" className="max-h-20 w-36 rounded-lg border border-slate-200 object-contain object-left" />
          ) : null}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-royal-700">Invoice</p>
            <h1 className="mt-0.5 text-xl font-semibold text-navy-950">{invoice.invoiceNumber || "Assigned when saved"}</h1>
            {invoice.title ? <p className="mt-0.5 text-sm text-slate-600">{invoice.title}</p> : null}
          </div>
        </div>
        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${statusStyles[invoice.status]}`}>
          {invoice.status}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-0.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
          <p className={fieldLabel}>From</p>
          <p className="font-semibold text-slate-900">{invoice.issuerName || "Your business name"}</p>
          {invoice.issuerTradingName ? <p className="text-sm text-slate-600">t/a {invoice.issuerTradingName}</p> : null}
          {invoice.issuerEmail ? <p className="text-sm text-slate-600">{invoice.issuerEmail}</p> : null}
          {invoice.issuerPhone ? <p className="text-sm text-slate-600">{invoice.issuerPhone}</p> : null}
          {invoice.issuerWebsite ? <p className="text-sm text-slate-600">{invoice.issuerWebsite}</p> : null}
          {invoice.issuerAddress ? <p className="text-sm text-slate-600">{invoice.issuerAddress}</p> : null}
          {invoice.issuerVatNumber ? <p className="text-xs text-slate-500">VAT no: {invoice.issuerVatNumber}</p> : null}
          {invoice.issuerRegistrationNumber ? <p className="text-xs text-slate-500">Reg no: {invoice.issuerRegistrationNumber}</p> : null}
        </div>
        <div className="space-y-0.5 rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
          <p className={fieldLabel}>Billed to</p>
          <p className="font-semibold text-slate-900">{invoice.clientName || "Client name"}</p>
          {shouldShowClientCompany ? <p className="text-sm text-slate-600">{invoice.clientCompanyName}</p> : null}
          {invoice.attentionTo ? <p className="text-sm text-slate-600">Attn: {invoice.attentionTo}</p> : null}
          {invoice.clientContactPerson ? <p className="text-sm text-slate-600">{invoice.clientContactPerson}</p> : null}
          {invoice.clientEmail ? <p className="text-sm text-slate-600">{invoice.clientEmail}</p> : null}
          {invoice.clientPhone ? <p className="text-sm text-slate-600">{invoice.clientPhone}</p> : null}
          {invoice.clientAddress ? <p className="text-sm text-slate-600">{invoice.clientAddress}</p> : null}
          {invoice.clientVatNumber ? <p className="text-xs text-slate-500">VAT no: {invoice.clientVatNumber}</p> : null}
          {invoice.clientRegistrationNumber ? <p className="text-xs text-slate-500">Reg no: {invoice.clientRegistrationNumber}</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-slate-100 p-3.5 text-sm sm:grid-cols-4">
        <div>
          <p className={fieldLabel}>Invoice date</p>
          <p className="mt-0.5 font-medium text-slate-900">{invoice.invoiceDate || "—"}</p>
        </div>
        <div>
          <p className={fieldLabel}>Due date</p>
          <p className="mt-0.5 font-medium text-slate-900">{invoice.dueDate || "—"}</p>
        </div>
        <div>
          <p className={fieldLabel}>Payment terms</p>
          <p className="mt-0.5 font-medium text-slate-900">{paymentTermsLabel}</p>
        </div>
        <div>
          <p className={fieldLabel}>Reference</p>
          <p className="mt-0.5 font-medium text-slate-900">{invoice.referenceNumber || invoice.purchaseOrderNumber || "—"}</p>
        </div>
      </div>

      {invoice.description ? <p className="text-sm leading-6 text-slate-600">{invoice.description}</p> : null}

      <InvoiceLineItemsEditor items={invoice.lineItems} currency={invoice.currency} readOnly />

      <div className="ml-auto max-w-xs space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
        <div className="flex justify-between text-slate-600">
          <span>Subtotal</span>
          <span className="font-medium text-slate-900">{formatCurrency(subtotal, invoice.currency)}</span>
        </div>
        {discountAmount > 0 ? (
          <div className="flex justify-between text-slate-600">
            <span>Discount</span>
            <span className="font-medium text-slate-900">-{formatCurrency(discountAmount, invoice.currency)}</span>
          </div>
        ) : null}
        {shippingAmount > 0 ? (
          <div className="flex justify-between text-slate-600">
            <span>Shipping</span>
            <span className="font-medium text-slate-900">{formatCurrency(shippingAmount, invoice.currency)}</span>
          </div>
        ) : null}
        {additionalCharges > 0 ? (
          <div className="flex justify-between text-slate-600">
            <span>Additional charges</span>
            <span className="font-medium text-slate-900">{formatCurrency(additionalCharges, invoice.currency)}</span>
          </div>
        ) : null}
        <div className="flex justify-between text-slate-600">
          <span>VAT</span>
          <span className="font-medium text-slate-900">{formatCurrency(vatAmount, invoice.currency)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-navy-950">
          <span>Grand total</span>
          <span>{formatCurrency(totalAmount, invoice.currency)}</span>
        </div>
        {amountPaid > 0 ? (
          <>
            <div className="flex justify-between text-slate-600">
              <span>Amount paid</span>
              <span className="font-medium text-slate-900">{formatCurrency(amountPaid, invoice.currency)}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-navy-950">
              <span>Balance due</span>
              <span>{formatCurrency(balanceDue, invoice.currency)}</span>
            </div>
          </>
        ) : null}
      </div>

      {hasBankDetails ? (
        <div className="rounded-xl border border-slate-100 p-3.5">
          <p className={fieldLabel}>Payment information</p>
          <div className="mt-1.5 grid gap-x-4 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            {invoice.bankName ? <p>Bank: {invoice.bankName}</p> : null}
            {invoice.bankAccountHolder ? <p>Account holder: {invoice.bankAccountHolder}</p> : null}
            {invoice.bankAccountNumber ? <p>Account number: {invoice.bankAccountNumber}</p> : null}
            {invoice.bankBranchCode ? <p>Branch code: {invoice.bankBranchCode}</p> : null}
            {invoice.bankSwift ? <p>SWIFT/BIC: {invoice.bankSwift}</p> : null}
            {invoice.paymentReference ? <p>Payment reference: {invoice.paymentReference}</p> : null}
          </div>
          {invoice.paymentInstructions ? <p className="mt-1.5 whitespace-pre-line text-sm text-slate-600">{invoice.paymentInstructions}</p> : null}
        </div>
      ) : null}

      {invoice.notesToClient ? (
        <div>
          <p className={fieldLabel}>Notes</p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{invoice.notesToClient}</p>
        </div>
      ) : null}

      {invoice.termsAndConditions ? (
        <div>
          <p className={fieldLabel}>Terms and conditions</p>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{invoice.termsAndConditions}</p>
        </div>
      ) : null}
    </div>
  );
}

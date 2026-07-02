import { calculateInvoiceFinalTotal, calculateInvoiceSubtotal, calculateInvoiceVatAmount, calculateLineTotalInclVat, formatCurrency, paymentTermsOptions } from "@/lib/invoice-utils";
import type { InvoicePreviewData } from "@/components/invoices/InvoicePreview";

const label = "text-[9.5px] font-semibold uppercase tracking-wide text-slate-500";

/**
 * Compact, print-only invoice layout — deliberately independent of the dashboard/card-styled
 * <InvoicePreview>. This is what actually gets rendered on paper/PDF via window.print(), so it
 * uses tight tables and borders instead of rounded cards/shadows, readable print text, and a
 * single-page-first layout, matching a real accounting invoice rather than a web app screenshot.
 * Rendered hidden on screen (`hidden print:block`) alongside the normal preview
 * (`print:hidden`) — see InvoiceDetail.
 */
export function InvoicePrintDocument({ invoice }: { invoice: InvoicePreviewData }) {
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
  const hasNotes = invoice.notesToClient || invoice.termsAndConditions;
  const normalizedClientName = invoice.clientName.trim().toLowerCase();
  const normalizedClientCompany = invoice.clientCompanyName?.trim().toLowerCase();
  const shouldShowClientCompany = Boolean(invoice.clientCompanyName && normalizedClientCompany !== normalizedClientName);

  return (
    <div className="mx-auto w-full max-w-[210mm] bg-white p-0 font-sans text-[11px] leading-snug text-slate-900">
      {/* Top header */}
      <div className="flex items-start justify-between gap-6 border-b border-slate-300 pb-2.5">
        <div className="flex min-w-0 items-start gap-3">
          {invoice.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL
            <img src={invoice.logoDataUrl} alt="" className="max-h-16 w-[135px] shrink-0 object-contain object-left" />
          ) : null}
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-slate-900">{invoice.issuerName || "Your business name"}</p>
            {invoice.issuerAddress ? <p className="text-slate-600">{invoice.issuerAddress}</p> : null}
            {invoice.issuerEmail ? <p className="text-slate-600">{invoice.issuerEmail}</p> : null}
            {invoice.issuerPhone ? <p className="text-slate-600">{invoice.issuerPhone}</p> : null}
            <p className="text-slate-500">
              {invoice.issuerVatNumber ? `VAT: ${invoice.issuerVatNumber}` : ""}
              {invoice.issuerVatNumber && invoice.issuerRegistrationNumber ? "  ·  " : ""}
              {invoice.issuerRegistrationNumber ? `Reg: ${invoice.issuerRegistrationNumber}` : ""}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[25px] font-bold uppercase tracking-wide text-slate-900">Tax invoice</p>
          <p className="mt-0.5 font-semibold text-slate-900">{invoice.invoiceNumber || "—"}</p>
          <p className="text-slate-600">Date: {invoice.invoiceDate || "—"}</p>
          <p className="text-slate-600">Due: {invoice.dueDate || "—"}</p>
          <p className="text-slate-600 capitalize">
            {invoice.status} · {paymentTermsLabel}
          </p>
          {invoice.referenceNumber || invoice.purchaseOrderNumber ? (
            <p className="text-slate-600">Ref: {invoice.referenceNumber || invoice.purchaseOrderNumber}</p>
          ) : null}
        </div>
      </div>

      {/* Business / client 2-column */}
      <div className="grid grid-cols-2 gap-6 border-b border-slate-300 py-2.5">
        <div>
          <p className={label}>From</p>
          <p className="font-semibold text-slate-900">{invoice.issuerName || "Your business name"}</p>
          {invoice.issuerTradingName ? <p className="text-slate-600">t/a {invoice.issuerTradingName}</p> : null}
          {invoice.issuerVatNumber ? <p className="text-slate-600">VAT: {invoice.issuerVatNumber}</p> : null}
          {invoice.issuerRegistrationNumber ? <p className="text-slate-600">Reg: {invoice.issuerRegistrationNumber}</p> : null}
          {invoice.issuerAddress ? <p className="text-slate-600">{invoice.issuerAddress}</p> : null}
          {invoice.issuerEmail ? <p className="text-slate-600">{invoice.issuerEmail}</p> : null}
          {invoice.issuerPhone ? <p className="text-slate-600">{invoice.issuerPhone}</p> : null}
        </div>
        <div>
          <p className={label}>Bill to</p>
          <p className="font-semibold text-slate-900">{invoice.clientName || "Client name"}</p>
          {shouldShowClientCompany ? <p className="text-slate-600">{invoice.clientCompanyName}</p> : null}
          {invoice.clientVatNumber ? <p className="text-slate-600">VAT: {invoice.clientVatNumber}</p> : null}
          {invoice.clientRegistrationNumber ? <p className="text-slate-600">Reg: {invoice.clientRegistrationNumber}</p> : null}
          {invoice.clientAddress ? <p className="text-slate-600">{invoice.clientAddress}</p> : null}
          {invoice.clientEmail ? <p className="text-slate-600">{invoice.clientEmail}</p> : null}
          {invoice.clientPhone ? <p className="text-slate-600">{invoice.clientPhone}</p> : null}
        </div>
      </div>

      {/* Payment details strip */}
      {hasBankDetails ? (
        <div className="border-b border-slate-300 py-2">
          <p className={label}>Payment details</p>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-slate-700">
            {invoice.bankName ? <span>Bank: {invoice.bankName}</span> : null}
            {invoice.bankAccountHolder ? <span>Acc holder: {invoice.bankAccountHolder}</span> : null}
            {invoice.bankAccountNumber ? <span>Acc no: {invoice.bankAccountNumber}</span> : null}
            {invoice.bankBranchCode ? <span>Branch: {invoice.bankBranchCode}</span> : null}
            {invoice.bankSwift ? <span>SWIFT: {invoice.bankSwift}</span> : null}
            {invoice.paymentReference ? <span>Ref: {invoice.paymentReference}</span> : null}
          </div>
          {invoice.paymentInstructions ? <p className="mt-1 whitespace-pre-line text-slate-600">{invoice.paymentInstructions}</p> : null}
        </div>
      ) : null}

      {/* Description */}
      {invoice.title || invoice.description ? (
        <div className="border-b border-slate-300 py-1.5">
          {invoice.title ? <p className="font-semibold text-slate-900">{invoice.title}</p> : null}
          {invoice.description ? <p className="text-slate-600">{invoice.description}</p> : null}
        </div>
      ) : null}

      {/* Line items table */}
      <table className="mt-2 w-full border-collapse text-[10.5px]">
        <thead>
          <tr className="border-b border-slate-400">
            <th className={`${label} px-1 py-1 text-left`}>Description</th>
            <th className={`${label} px-1 py-1 text-right`}>Qty</th>
            <th className={`${label} px-1 py-1 text-right`}>Unit price</th>
            <th className={`${label} px-1 py-1 text-right`}>VAT</th>
            <th className={`${label} px-1 py-1 text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((item, index) => (
            <tr key={item.id ?? index} className="border-b border-slate-200">
              <td className="px-1 py-1">{item.serviceItem || "Service item"}</td>
              <td className="px-1 py-1 text-right">{item.quantity || "1"}</td>
              <td className="px-1 py-1 text-right">{formatCurrency(Number(item.unitPrice || 0), invoice.currency)}</td>
              <td className="px-1 py-1 text-right">{item.vatType === "custom" ? `${item.vatRate}%` : item.vatType === "standard" ? "15%" : "0%"}</td>
              <td className="px-1 py-1 text-right font-medium">{formatCurrency(calculateLineTotalInclVat(item), invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mt-2 flex justify-end">
        <table className="w-64 border-collapse text-[10.5px]">
          <tbody>
            <tr>
              <td className="px-1 py-0.5 text-slate-600">Subtotal</td>
              <td className="px-1 py-0.5 text-right font-medium">{formatCurrency(subtotal, invoice.currency)}</td>
            </tr>
            {discountAmount > 0 ? (
              <tr>
                <td className="px-1 py-0.5 text-slate-600">Discount</td>
                <td className="px-1 py-0.5 text-right font-medium">-{formatCurrency(discountAmount, invoice.currency)}</td>
              </tr>
            ) : null}
            {shippingAmount > 0 ? (
              <tr>
                <td className="px-1 py-0.5 text-slate-600">Shipping</td>
                <td className="px-1 py-0.5 text-right font-medium">{formatCurrency(shippingAmount, invoice.currency)}</td>
              </tr>
            ) : null}
            {additionalCharges > 0 ? (
              <tr>
                <td className="px-1 py-0.5 text-slate-600">Additional charges</td>
                <td className="px-1 py-0.5 text-right font-medium">{formatCurrency(additionalCharges, invoice.currency)}</td>
              </tr>
            ) : null}
            <tr>
              <td className="px-1 py-0.5 text-slate-600">VAT</td>
              <td className="px-1 py-0.5 text-right font-medium">{formatCurrency(vatAmount, invoice.currency)}</td>
            </tr>
            <tr className="border-t border-slate-400">
              <td className="px-1 py-1 text-[13px] font-bold text-slate-900">Grand total</td>
              <td className="px-1 py-1 text-right text-[13px] font-bold text-slate-900">{formatCurrency(totalAmount, invoice.currency)}</td>
            </tr>
            {amountPaid > 0 ? (
              <>
                <tr>
                  <td className="px-1 py-0.5 text-slate-600">Amount paid</td>
                  <td className="px-1 py-0.5 text-right font-medium">{formatCurrency(amountPaid, invoice.currency)}</td>
                </tr>
                <tr className="border-t border-slate-300">
                  <td className="px-1 py-0.5 font-semibold text-slate-900">Balance due</td>
                  <td className="px-1 py-0.5 text-right font-semibold text-slate-900">{formatCurrency(balanceDue, invoice.currency)}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Notes and terms */}
      {hasNotes ? (
        <div className="mt-4 space-y-3 border-t border-slate-300 pt-2.5 text-[9.5px] text-slate-600">
          {invoice.notesToClient ? (
            <div>
              <p className={label}>Notes</p>
              <p className="mt-0.5 whitespace-pre-line">{invoice.notesToClient}</p>
            </div>
          ) : null}
          {invoice.termsAndConditions ? (
            <div className="pt-1">
              <p className={label}>Terms and conditions</p>
              <p className="mt-0.5 whitespace-pre-line">{invoice.termsAndConditions}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 border-t border-slate-300 pt-2 text-center text-[9.5px] font-medium text-slate-600">
        Generated by DocuCoreX | Document Intelligence Platform
      </div>
    </div>
  );
}

import type { InvoiceLineItemDraft, InvoicePaymentTerms, InvoiceVatType } from "@/lib/types";

// Pure calculation helpers (ported from Acapolite-Consulting's invoiceUtils.ts, extended with
// per-line VAT handling). Kept dependency-free so it can be safely imported from both client
// and server code.

export const paymentTermsOptions: { value: InvoicePaymentTerms; label: string }[] = [
  { value: "due_on_receipt", label: "Due on receipt" },
  { value: "7_days", label: "7 days" },
  { value: "14_days", label: "14 days" },
  { value: "30_days", label: "30 days" },
  { value: "60_days", label: "60 days" },
  { value: "90_days", label: "90 days" },
];

export const vatTypeOptions: { value: InvoiceVatType; label: string }[] = [
  { value: "exempt", label: "VAT exempt" },
  { value: "zero_rated", label: "Zero rated" },
  { value: "standard", label: "Standard (15%)" },
  { value: "custom", label: "Custom %" },
];

export function createEmptyInvoiceLineItem(): InvoiceLineItemDraft {
  return {
    serviceItem: "",
    quantity: "1",
    unitPrice: "",
    vatType: "standard",
    vatRate: "15",
  };
}

export function formatCurrency(amount: number, currency = "ZAR") {
  const locale = currency === "ZAR" ? "en-ZA" : "en-US";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      Number(amount || 0),
    );
  } catch {
    return `${currency} ${Number(amount || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function parseNumericInput(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The VAT rate that actually applies for a line item, taking its VAT type into account
// (exempt/zero-rated always resolve to 0%, regardless of what's stored in vatRate).
export function effectiveVatRate(item: Pick<InvoiceLineItemDraft, "vatType" | "vatRate">) {
  if (item.vatType === "exempt" || item.vatType === "zero_rated") return 0;
  if (item.vatType === "custom") return parseNumericInput(item.vatRate);
  return 15; // standard
}

export function calculateLineItemTotal(item: InvoiceLineItemDraft) {
  return parseNumericInput(item.quantity) * parseNumericInput(item.unitPrice);
}

export function calculateLineVatAmount(item: InvoiceLineItemDraft) {
  return calculateLineItemTotal(item) * (effectiveVatRate(item) / 100);
}

export function calculateLineTotalInclVat(item: InvoiceLineItemDraft) {
  return calculateLineItemTotal(item) + calculateLineVatAmount(item);
}

export function calculateInvoiceSubtotal(items: InvoiceLineItemDraft[]) {
  return items.reduce((total, item) => total + calculateLineItemTotal(item), 0);
}

// Sum of each line's own VAT, proportionally reduced if a flat invoice-level discount is
// applied (the discount is treated as reducing the taxable base evenly across all lines).
export function calculateInvoiceVatAmount(items: InvoiceLineItemDraft[], discountAmount: string) {
  const subtotal = calculateInvoiceSubtotal(items);
  const discount = parseNumericInput(discountAmount);
  const discountRatio = subtotal > 0 ? Math.min(discount, subtotal) / subtotal : 0;

  return items.reduce((total, item) => total + calculateLineVatAmount(item) * (1 - discountRatio), 0);
}

export function calculateInvoiceFinalTotal(
  items: InvoiceLineItemDraft[],
  discountAmount: string,
  shippingAmount = "0",
  additionalCharges = "0",
) {
  const subtotal = calculateInvoiceSubtotal(items);
  const discount = parseNumericInput(discountAmount);
  const shipping = parseNumericInput(shippingAmount);
  const additional = parseNumericInput(additionalCharges);
  const amountAfterDiscount = Math.max(subtotal - discount, 0);
  const vatAmount = calculateInvoiceVatAmount(items, discountAmount);

  return Math.max(amountAfterDiscount + vatAmount + shipping + additional, 0);
}

import type { InvoiceLineItemDraft } from "@/lib/types";

// Pure calculation helpers (ported from Acapolite-Consulting's invoiceUtils.ts).
// Kept dependency-free so it can be safely imported from both client and server code.

export function createEmptyInvoiceLineItem(): InvoiceLineItemDraft {
  return {
    serviceItem: "",
    quantity: "1",
    unitPrice: "",
  };
}

export function formatCurrency(amount: number) {
  return `R ${Number(amount || 0).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function parseNumericInput(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateLineItemTotal(item: InvoiceLineItemDraft) {
  return parseNumericInput(item.quantity) * parseNumericInput(item.unitPrice);
}

export function calculateInvoiceSubtotal(items: InvoiceLineItemDraft[]) {
  return items.reduce((total, item) => total + calculateLineItemTotal(item), 0);
}

export function calculateInvoiceVatAmount(items: InvoiceLineItemDraft[], taxRate: string, discountAmount: string) {
  const subtotal = calculateInvoiceSubtotal(items);
  const discount = parseNumericInput(discountAmount);
  const rate = parseNumericInput(taxRate);
  const amountAfterDiscount = Math.max(subtotal - discount, 0);
  return amountAfterDiscount * (rate / 100);
}

export function calculateInvoiceFinalTotal(items: InvoiceLineItemDraft[], taxRate: string, discountAmount: string) {
  const subtotal = calculateInvoiceSubtotal(items);
  const discount = parseNumericInput(discountAmount);
  const amountAfterDiscount = Math.max(subtotal - discount, 0);
  const vatAmount = calculateInvoiceVatAmount(items, taxRate, discountAmount);

  return Math.max(amountAfterDiscount + vatAmount, 0);
}

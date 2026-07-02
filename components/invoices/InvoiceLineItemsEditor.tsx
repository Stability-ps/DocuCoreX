"use client";

import { Plus, Trash2 } from "lucide-react";
import { calculateLineItemTotal, createEmptyInvoiceLineItem, formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft } from "@/lib/types";

const inputClassName =
  "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-royal-500 focus:ring-2 focus:ring-royal-100";

export function InvoiceLineItemsEditor({
  items,
  readOnly = false,
  onChange,
}: {
  items: InvoiceLineItemDraft[];
  readOnly?: boolean;
  onChange?: (items: InvoiceLineItemDraft[]) => void;
}) {
  const updateItem = (index: number, field: keyof InvoiceLineItemDraft, value: string) => {
    if (!onChange) return;
    onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)));
  };

  const addItem = () => {
    if (!onChange) return;
    onChange([...items, createEmptyInvoiceLineItem()]);
  };

  const removeItem = (index: number) => {
    if (!onChange) return;
    const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
    onChange(nextItems.length ? nextItems : [createEmptyInvoiceLineItem()]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Invoice line items</p>
          <p className="text-xs text-slate-500">Add each billed service, quantity, and unit price.</p>
        </div>
        {!readOnly ? (
          <button
            type="button"
            onClick={addItem}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-royal-300 hover:text-royal-700"
          >
            <Plus className="h-4 w-4" />
            Add item
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div
          className={`hidden gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid ${
            readOnly ? "md:grid-cols-[minmax(0,1.9fr)_110px_140px_140px]" : "md:grid-cols-[minmax(0,1.9fr)_110px_140px_140px_52px]"
          }`}
        >
          <p>Service item</p>
          <p>Quantity</p>
          <p>Price</p>
          <p>Total</p>
        </div>
        <div className="divide-y divide-slate-100">
          {items.map((item, index) => (
            <div
              key={item.id ?? `item-${index}`}
              className={`grid grid-cols-1 gap-3 px-4 py-4 md:gap-3 ${
                readOnly
                  ? "md:grid-cols-[minmax(0,1.9fr)_110px_140px_140px]"
                  : "md:grid-cols-[minmax(0,1.9fr)_110px_140px_140px_52px]"
              }`}
            >
              {readOnly ? (
                <>
                  <p className="text-sm text-slate-900">{item.serviceItem || "Service item"}</p>
                  <p className="text-sm text-slate-900">{item.quantity || "1"}</p>
                  <p className="text-sm text-slate-900">{formatCurrency(Number(item.unitPrice || 0))}</p>
                  <p className="text-sm font-semibold text-slate-900">{formatCurrency(calculateLineItemTotal(item))}</p>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 md:hidden">Service item</label>
                    <input
                      value={item.serviceItem}
                      onChange={(event) => updateItem(index, "serviceItem", event.target.value)}
                      placeholder="Example: Bookkeeping services"
                      className={inputClassName}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:contents">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 md:hidden">Quantity</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={item.quantity}
                        onChange={(event) => updateItem(index, "quantity", event.target.value)}
                        className={inputClassName}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 md:hidden">Price</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(event) => updateItem(index, "unitPrice", event.target.value)}
                        className={inputClassName}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 md:hidden">Total</label>
                    <div className="flex min-h-11 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-900">
                      {formatCurrency(calculateLineItemTotal(item))}
                    </div>
                  </div>
                  <div className="flex justify-end md:block">
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      disabled={items.length === 1}
                      className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 md:w-11 md:justify-center md:px-0"
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="md:hidden">Remove item</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

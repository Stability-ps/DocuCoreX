"use client";

import { Copy, Plus, Trash2 } from "lucide-react";
import { calculateLineTotalInclVat, createEmptyInvoiceLineItem, formatCurrency, vatTypeOptions } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceVatType } from "@/lib/types";

const inputClassName =
  "min-h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-royal-500 focus:ring-2 focus:ring-royal-100";

export function InvoiceLineItemsEditor({
  items,
  readOnly = false,
  currency = "ZAR",
  onChange,
}: {
  items: InvoiceLineItemDraft[];
  readOnly?: boolean;
  currency?: string;
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

  const duplicateItem = (index: number) => {
    if (!onChange) return;
    const copy = { ...items[index], id: undefined };
    onChange([...items.slice(0, index + 1), copy, ...items.slice(index + 1)]);
  };

  const removeItem = (index: number) => {
    if (!onChange) return;
    const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
    onChange(nextItems.length ? nextItems : [createEmptyInvoiceLineItem()]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-900">Invoice line items</p>
        {!readOnly ? (
          <button
            type="button"
            onClick={addItem}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300 hover:text-royal-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add item
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div
          className={`hidden gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:grid ${
            readOnly ? "md:grid-cols-[minmax(0,2fr)_70px_100px_130px_100px]" : "md:grid-cols-[minmax(0,2fr)_70px_100px_150px_100px_88px]"
          }`}
        >
          <p>Description</p>
          <p>Qty</p>
          <p>Unit price</p>
          <p>VAT</p>
          <p>Amount</p>
        </div>
        <div className="divide-y divide-slate-100">
          {items.map((item, index) => (
            <div
              key={item.id ?? `item-${index}`}
              className={`grid grid-cols-1 gap-2.5 px-3 py-3 md:gap-2 ${
                readOnly
                  ? "md:grid-cols-[minmax(0,2fr)_70px_100px_130px_100px] md:items-center"
                  : "md:grid-cols-[minmax(0,2fr)_70px_100px_150px_100px_88px] md:items-center"
              }`}
            >
              {readOnly ? (
                <>
                  <p className="text-sm text-slate-900">{item.serviceItem || "Service item"}</p>
                  <p className="text-sm text-slate-600">{item.quantity || "1"}</p>
                  <p className="text-sm text-slate-600">{formatCurrency(Number(item.unitPrice || 0), currency)}</p>
                  <p className="text-sm text-slate-600">{vatTypeOptions.find((option) => option.value === item.vatType)?.label ?? "Standard"}</p>
                  <p className="text-sm font-semibold text-slate-900">{formatCurrency(calculateLineTotalInclVat(item), currency)}</p>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">Description</label>
                    <input
                      value={item.serviceItem}
                      onChange={(event) => updateItem(index, "serviceItem", event.target.value)}
                      placeholder="e.g. Bookkeeping services"
                      className={inputClassName}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 md:contents">
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">Qty</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={item.quantity}
                        onChange={(event) => updateItem(index, "quantity", event.target.value)}
                        className={inputClassName}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">Unit price</label>
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
                  <div className="flex gap-1.5">
                    <div className="flex-1 space-y-1">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">VAT</label>
                      <select
                        value={item.vatType}
                        onChange={(event) => updateItem(index, "vatType", event.target.value as InvoiceVatType)}
                        className={inputClassName}
                      >
                        {vatTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {item.vatType === "custom" ? (
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.vatRate}
                        onChange={(event) => updateItem(index, "vatRate", event.target.value)}
                        placeholder="%"
                        className={`${inputClassName} w-16 flex-none`}
                      />
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">Amount</label>
                    <div className="flex min-h-9 items-center rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-sm font-semibold text-slate-900">
                      {formatCurrency(calculateLineTotalInclVat(item), currency)}
                    </div>
                  </div>
                  <div className="flex justify-end gap-1 md:justify-center">
                    <button
                      type="button"
                      onClick={() => duplicateItem(index)}
                      title="Duplicate item"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      disabled={items.length === 1}
                      title="Delete item"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        {!readOnly ? (
          <button
            type="button"
            onClick={addItem}
            className="flex w-full items-center justify-center gap-1.5 border-t border-slate-100 px-3 py-2.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-royal-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Add another item
          </button>
        ) : null}
      </div>
    </div>
  );
}

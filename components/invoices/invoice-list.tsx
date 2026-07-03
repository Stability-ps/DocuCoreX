"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Eye,
  FileText,
  Filter,
  Mail,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  ArrowUpDown,
} from "lucide-react";
import { formatCurrency } from "@/lib/invoice-utils";
import type { InvoiceRecord, InvoiceStatus, InvoiceWithItems } from "@/lib/types";

// Soft filled pills — no outlined badges, per design spec.
const statusStyles: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-500",
  issued: "bg-blue-50 text-blue-700",
  paid: "bg-emerald-50 text-emerald-700",
  overdue: "bg-rose-50 text-rose-700",
  cancelled: "bg-slate-200 text-slate-500",
};

const statusLabels: Record<InvoiceStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  paid: "Paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

const statusFilters: { value: InvoiceStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
];

const dateFilters: { value: string; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "year", label: "This year" },
];

function formatShortDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short" });
}

type SortOption = "due_asc" | "due_desc" | "amount_desc" | "newest";

const sortOptions: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "due_asc", label: "Due date (earliest)" },
  { value: "due_desc", label: "Due date (latest)" },
  { value: "amount_desc", label: "Amount (highest)" },
];

// Deterministic avatar color per client, so the same client always renders the same badge
// color across the list without needing a stored client entity/logo.
const avatarPalette = [
  { bg: "bg-blue-100", text: "text-blue-700" },
  { bg: "bg-emerald-100", text: "text-emerald-700" },
  { bg: "bg-amber-100", text: "text-amber-700" },
  { bg: "bg-violet-100", text: "text-violet-700" },
  { bg: "bg-rose-100", text: "text-rose-700" },
  { bg: "bg-teal-100", text: "text-teal-700" },
  { bg: "bg-sky-100", text: "text-sky-700" },
];

function avatarStyle(name: string) {
  const hash = name.split("").reduce((total, char) => total + char.charCodeAt(0), 0);
  return avatarPalette[hash % avatarPalette.length];
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function formatDueDate(dueDate: string | null) {
  if (!dueDate) return "Due —";
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) return "Due —";
  return `Due ${date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}`;
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-3">
      <div className="h-9 w-9 flex-none animate-pulse rounded-full bg-slate-100" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3.5 w-1/3 animate-pulse rounded bg-slate-100" />
        <div className="h-3 w-1/4 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="space-y-2 text-right">
        <div className="h-4 w-20 animate-pulse rounded bg-slate-100" />
        <div className="h-4 w-14 animate-pulse rounded-full bg-slate-100" />
      </div>
    </div>
  );
}

export function InvoiceList() {
  const [invoices, setInvoices] = useState<InvoiceRecord[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [sort, setSort] = useState<SortOption>("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [showSort, setShowSort] = useState(false);
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const [busyId, setBusyId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  async function load() {
    const response = await fetch("/api/invoices");
    if (!response.ok) {
      setInvoices([]);
      setError("Unable to load invoices. Refresh to try again.");
      return;
    }
    const data = (await response.json()) as { invoices: InvoiceRecord[] };
    setInvoices(data.invoices);
    setError("");
  }

  useEffect(() => {
    void load();
  }, []);

  // Close any open dropdown (row menu, filters, sort, date) when clicking outside the list.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
        setShowFilters(false);
        setShowSort(false);
        setShowDateFilter(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const summary = useMemo(() => {
    const base = { amount: 0, count: 0 };
    const totals: Record<"outstanding" | "paid" | "overdue" | "draft", { amount: number; count: number }> = {
      outstanding: { ...base },
      paid: { ...base },
      overdue: { ...base },
      draft: { ...base },
    };

    for (const invoice of invoices ?? []) {
      if (invoice.status === "issued") {
        totals.outstanding.amount += invoice.totalAmount - invoice.amountPaid;
        totals.outstanding.count += 1;
      } else if (invoice.status === "paid") {
        totals.paid.amount += invoice.totalAmount;
        totals.paid.count += 1;
      } else if (invoice.status === "overdue") {
        // Overdue invoices are unpaid, so they also count toward Outstanding.
        totals.outstanding.amount += invoice.totalAmount - invoice.amountPaid;
        totals.outstanding.count += 1;
        totals.overdue.amount += invoice.totalAmount - invoice.amountPaid;
        totals.overdue.count += 1;
      } else if (invoice.status === "draft") {
        totals.draft.amount += invoice.totalAmount;
        totals.draft.count += 1;
      }
    }

    return totals;
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    let result = [...(invoices ?? [])];

    if (statusFilter !== "all") {
      result = result.filter((invoice) => invoice.status === statusFilter);
    }

    if (dateFilter === "custom") {
      result = result.filter((invoice) => {
        const invoiceDay = invoice.invoiceDate;
        if (!invoiceDay) return true;
        if (customFrom && invoiceDay < customFrom) return false;
        if (customTo && invoiceDay > customTo) return false;
        return true;
      });
    } else if (dateFilter !== "all") {
      const now = Date.now();
      const cutoffDays = dateFilter === "30" ? 30 : dateFilter === "90" ? 90 : null;
      result = result.filter((invoice) => {
        const created = new Date(invoice.invoiceDate).getTime();
        if (Number.isNaN(created)) return true;
        if (dateFilter === "year") return new Date(invoice.invoiceDate).getFullYear() === new Date().getFullYear();
        if (cutoffDays) return now - created <= cutoffDays * 24 * 60 * 60 * 1000;
        return true;
      });
    }

    const search = query.trim().toLowerCase();
    if (search) {
      result = result.filter(
        (invoice) =>
          invoice.invoiceNumber.toLowerCase().includes(search) ||
          invoice.clientName.toLowerCase().includes(search) ||
          (invoice.title ?? "").toLowerCase().includes(search),
      );
    }

    result.sort((a, b) => {
      switch (sort) {
        case "due_asc":
          return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
        case "due_desc":
          return (b.dueDate ?? "0000").localeCompare(a.dueDate ?? "0000");
        case "amount_desc":
          return b.totalAmount - a.totalAmount;
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });

    return result;
  }, [invoices, statusFilter, dateFilter, customFrom, customTo, query, sort]);

  const visibleInvoices = filteredInvoices.slice(0, visibleCount);

  async function markAsPaid(id: string) {
    setBusyId(id);
    const response = await fetch(`/api/invoices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    });
    if (response.ok) {
      setInvoices((current) => (current ? current.map((invoice) => (invoice.id === id ? { ...invoice, status: "paid" } : invoice)) : current));
    }
    setBusyId(null);
    setOpenMenuId(null);
  }

  // There's no destructive delete endpoint (and adding one would mean modifying the invoice
  // data/API layer this list doesn't own). "Delete" instead soft-deletes by marking the
  // invoice cancelled via the existing status-update endpoint, which already supports it.
  async function deleteInvoice(id: string) {
    if (!window.confirm("Delete this invoice? It will be marked as cancelled and removed from active views.")) return;
    setBusyId(id);
    const response = await fetch(`/api/invoices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    if (response.ok) {
      setInvoices((current) => (current ? current.map((invoice) => (invoice.id === id ? { ...invoice, status: "cancelled" } : invoice)) : current));
    }
    setBusyId(null);
    setOpenMenuId(null);
  }

  // No dedicated duplicate endpoint either — reuses the existing create endpoint with the
  // fetched invoice's own fields, the same one the create form already posts to.
  async function duplicateInvoice(invoice: InvoiceRecord) {
    setBusyId(invoice.id);
    const detailResponse = await fetch(`/api/invoices/${invoice.id}`);
    if (!detailResponse.ok) {
      setBusyId(null);
      return;
    }
    const { invoice: full } = (await detailResponse.json()) as { invoice: InvoiceWithItems };

    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: full.title ? `${full.title} (Copy)` : "Copy of invoice",
        description: full.description,
        status: "draft",
        currency: full.currency,
        paymentTerms: full.paymentTerms,
        referenceNumber: full.referenceNumber,
        purchaseOrderNumber: full.purchaseOrderNumber,
        internalNotes: full.internalNotes,
        clientName: full.clientName,
        clientCompanyName: full.clientCompanyName,
        clientContactPerson: full.clientContactPerson,
        clientEmail: full.clientEmail,
        clientPhone: full.clientPhone,
        clientAddress: full.clientAddress,
        clientPostalAddress: full.clientPostalAddress,
        clientVatNumber: full.clientVatNumber,
        clientRegistrationNumber: full.clientRegistrationNumber,
        attentionTo: full.attentionTo,
        clientReference: full.clientReference,
        issuerName: full.issuerName,
        issuerTradingName: full.issuerTradingName,
        issuerEmail: full.issuerEmail,
        issuerPhone: full.issuerPhone,
        issuerWebsite: full.issuerWebsite,
        issuerAddress: full.issuerAddress,
        issuerPostalAddress: full.issuerPostalAddress,
        issuerVatNumber: full.issuerVatNumber,
        issuerRegistrationNumber: full.issuerRegistrationNumber,
        logoDataUrl: full.logoDataUrl,
        bankName: full.bankName,
        bankAccountHolder: full.bankAccountHolder,
        bankAccountNumber: full.bankAccountNumber,
        bankBranchCode: full.bankBranchCode,
        bankSwift: full.bankSwift,
        paymentReference: full.paymentReference,
        paymentInstructions: full.paymentInstructions,
        bankDetails: full.bankDetails,
        notesToClient: full.notesToClient,
        termsAndConditions: full.termsAndConditions,
        discountAmount: full.discountAmount,
        shippingAmount: full.shippingAmount,
        additionalCharges: full.additionalCharges,
        lineItems: full.items.map((item) => ({
          serviceItem: item.serviceItem,
          quantity: String(item.quantity),
          unitPrice: String(item.unitPrice),
          vatType: item.vatType,
          vatRate: String(item.vatRate),
        })),
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { invoice: InvoiceRecord };
      setInvoices((current) => (current ? [data.invoice, ...current] : [data.invoice]));
    }
    setBusyId(null);
    setOpenMenuId(null);
  }

  function emailInvoice(invoice: InvoiceRecord) {
    const subject = `Invoice ${invoice.invoiceNumber} from ${invoice.issuerName || "us"}`;
    const body = [
      `Hi ${invoice.clientName || ""},`,
      "",
      `Please find your invoice ${invoice.invoiceNumber} summarized below:`,
      `Total due: ${formatCurrency(invoice.totalAmount, invoice.currency)}`,
      invoice.dueDate ? `Due date: ${invoice.dueDate}` : "",
      "",
      "A printable copy is attached — open the invoice and use \"Print / Save as PDF\" to attach it before sending.",
    ]
      .filter(Boolean)
      .join("\n");
    window.location.href = `mailto:${encodeURIComponent(invoice.clientEmail || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setOpenMenuId(null);
  }

  const isLoading = invoices === null;
  const summaryCards = [
    { key: "outstanding", label: "Outstanding", icon: FileText, iconBg: "bg-blue-50", iconColor: "text-blue-600", amountColor: "text-blue-700", data: summary.outstanding },
    { key: "paid", label: "Paid", icon: CheckCircle2, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", amountColor: "text-emerald-700", data: summary.paid },
    { key: "overdue", label: "Overdue", icon: Clock, iconBg: "bg-rose-50", iconColor: "text-rose-600", amountColor: "text-rose-700", data: summary.overdue },
    { key: "draft", label: "Draft", icon: FileText, iconBg: "bg-slate-100", iconColor: "text-slate-500", amountColor: "text-slate-900", data: summary.draft },
  ] as const;

  return (
    <div ref={containerRef} className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Invoices</h1>
          <p className="text-xs text-slate-500">Create, manage and track your invoices.</p>
        </div>
        <Link
          href="/invoices/new"
          className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-royal-600 px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700"
        >
          <Plus className="h-4 w-4" />
          New Invoice
        </Link>
      </div>

      {/* Search — full width on its own row */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by client, invoice or number..."
          className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-royal-300 focus:ring-2 focus:ring-royal-100"
        />
      </div>

      {/* Filters | Sort | Calendar — one even row, never wraps */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <button
            type="button"
            onClick={() => {
              setShowFilters((value) => !value);
              setShowSort(false);
              setShowDateFilter(false);
            }}
            className={`inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition ${
              statusFilter !== "all" ? "border-royal-300 bg-royal-50 text-royal-700" : "border-slate-200 bg-white text-slate-600 hover:border-royal-300"
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
          </button>
          {showFilters ? (
            <div className="absolute right-0 top-11 z-20 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-soft">
              {statusFilters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setStatusFilter(option.value);
                    setShowFilters(false);
                  }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition hover:bg-slate-50 ${
                    statusFilter === option.value ? "text-royal-700" : "text-slate-600"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative flex-1">
          <button
            type="button"
            onClick={() => {
              setShowSort((value) => !value);
              setShowFilters(false);
              setShowDateFilter(false);
            }}
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:border-royal-300"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            Sort
          </button>
          {showSort ? (
            <div className="absolute right-0 top-11 z-20 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-soft">
              {sortOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setSort(option.value);
                    setShowSort(false);
                  }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition hover:bg-slate-50 ${
                    sort === option.value ? "text-royal-700" : "text-slate-600"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative flex-1">
          <button
            type="button"
            onClick={() => {
              setShowDateFilter((value) => !value);
              setShowFilters(false);
              setShowSort(false);
            }}
            className={`inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition ${
              dateFilter !== "all" ? "border-royal-300 bg-royal-50 text-royal-700" : "border-slate-200 bg-white text-slate-600 hover:border-royal-300"
            }`}
            title="Filter by date"
            aria-label="Filter by date"
          >
            <Calendar className="h-3.5 w-3.5" />
            {dateFilter === "custom" && customFrom && customTo
              ? `${formatShortDate(customFrom)} – ${formatShortDate(customTo)}`
              : "Date"}
          </button>
          {showDateFilter ? (
            <div className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-soft">
              {dateFilters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setDateFilter(option.value);
                    setCustomFrom("");
                    setCustomTo("");
                    setShowDateFilter(false);
                  }}
                  className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition hover:bg-slate-50 ${
                    dateFilter === option.value ? "text-royal-700" : "text-slate-600"
                  }`}
                >
                  {option.label}
                </button>
              ))}
              <div className="my-1 border-t border-slate-100" />
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Custom range
              </p>
              <div className="flex items-center gap-2 px-2.5 pb-2">
                <label className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-slate-500">From</span>
                  <input
                    type="date"
                    value={customFrom}
                    max={customTo || undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustomFrom(value);
                      if (value && customTo) {
                        setDateFilter("custom");
                        setShowDateFilter(false);
                      }
                    }}
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-royal-300 focus:ring-2 focus:ring-royal-100"
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-slate-500">To</span>
                  <input
                    type="date"
                    value={customTo}
                    min={customFrom || undefined}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustomTo(value);
                      if (value && customFrom) {
                        setDateFilter("custom");
                        setShowDateFilter(false);
                      }
                    }}
                    className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none transition focus:border-royal-300 focus:ring-2 focus:ring-royal-100"
                  />
                </label>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

      {/* Summary cards — horizontal scroll only on mobile, never vertical */}
      <div className="no-scrollbar -mx-1 mb-1 flex snap-x snap-mandatory flex-nowrap gap-2.5 overflow-x-auto overflow-y-hidden px-1 pb-1 [-webkit-overflow-scrolling:touch] sm:grid sm:grid-cols-4 sm:overflow-visible">
        {summaryCards.map((card) => (
          <div
            key={card.key}
            className="w-[155px] flex-none snap-start rounded-2xl border border-slate-200 bg-white p-3 sm:w-auto"
          >
            <div className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${card.iconBg}`}>
              <card.icon className={`h-3.5 w-3.5 ${card.iconColor}`} />
            </div>
            <p className="mt-2 text-xs font-semibold text-slate-500">{card.label}</p>
            <p className={`mt-0.5 text-base font-bold ${card.amountColor}`}>{formatCurrency(card.data.amount, "ZAR")}</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {card.data.count} invoice{card.data.count === 1 ? "" : "s"}
            </p>
          </div>
        ))}
      </div>

      {/* Invoice cards */}
      {isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonRow key={index} />
          ))}
        </div>
      ) : filteredInvoices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-semibold text-navy-950">
            {invoices && invoices.length > 0 ? "No invoices match your filters" : "No invoices yet"}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {invoices && invoices.length > 0 ? "Try a different search or clear your filters." : "Create your first invoice to get started."}
          </p>
          {!invoices || invoices.length === 0 ? (
            <Link
              href="/invoices/new"
              className="mt-4 inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700"
            >
              <Plus className="h-4 w-4" />
              Create invoice
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {visibleInvoices.map((invoice) => {
              const avatar = avatarStyle(invoice.clientName || "?");
              const menuOpen = openMenuId === invoice.id;
              const busy = busyId === invoice.id;

              return (
                <div
                  key={invoice.id}
                  className="group relative rounded-2xl border border-slate-200 bg-white p-3 transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  <Link href={`/invoices/${invoice.id}`} className="flex items-center gap-2.5 pr-9">
                    <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-xs font-bold ${avatar.bg} ${avatar.text}`}>
                      {initialsFor(invoice.clientName || "?")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[16px] font-semibold leading-tight text-slate-900">{invoice.clientName || "Unnamed client"}</p>
                      <p className="truncate text-[13px] text-slate-500">{invoice.title || "Untitled invoice"}</p>
                      <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">
                        {invoice.invoiceNumber} · {formatDueDate(invoice.dueDate)}
                      </p>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1 pl-2">
                      <p className="text-[19px] font-bold leading-none text-slate-900">{formatCurrency(invoice.totalAmount, invoice.currency)}</p>
                      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusStyles[invoice.status]}`}>
                        {statusLabels[invoice.status]}
                      </span>
                    </div>
                  </Link>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenMenuId(menuOpen ? null : invoice.id);
                    }}
                    disabled={busy}
                    className={`absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-300 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 sm:right-3 ${
                      menuOpen ? "opacity-100" : "opacity-60 sm:opacity-0 sm:group-hover:opacity-100"
                    }`}
                    title="More actions"
                    aria-label="More actions"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>

                  {menuOpen ? (
                    <div className="absolute right-2 top-12 z-20 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-soft sm:right-3">
                      <Link
                        href={`/invoices/${invoice.id}`}
                        onClick={() => setOpenMenuId(null)}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <Eye className="h-3.5 w-3.5" /> Open
                      </Link>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        onClick={() => setOpenMenuId(null)}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Link>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        target="_blank"
                        onClick={() => setOpenMenuId(null)}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <FileText className="h-3.5 w-3.5" /> Preview PDF
                      </Link>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        target="_blank"
                        onClick={() => setOpenMenuId(null)}
                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <Download className="h-3.5 w-3.5" /> Download PDF
                      </Link>
                      <button
                        type="button"
                        onClick={() => emailInvoice(invoice)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                      >
                        <Mail className="h-3.5 w-3.5" /> Email invoice
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void duplicateInvoice(invoice)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                      >
                        <Copy className="h-3.5 w-3.5" /> Duplicate
                      </button>
                      {invoice.status !== "paid" ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void markAsPaid(invoice.id)}
                          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Mark as paid
                        </button>
                      ) : null}
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void deleteInvoice(invoice.id)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {visibleInvoices.length < filteredInvoices.length ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + 20)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-royal-300 hover:text-royal-700"
              >
                Load more ({filteredInvoices.length - visibleInvoices.length} remaining)
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

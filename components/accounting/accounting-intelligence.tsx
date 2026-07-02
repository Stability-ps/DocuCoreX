"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  BadgeCheck,
  Banknote,
  Building2,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Filter,
  Loader2,
  MoreVertical,
  PencilLine,
  RefreshCcw,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type {
  AccountingRunDetail,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
  VatTreatment,
} from "@/lib/accounting/types";

type AccountingTab = "transactions" | "review" | "summary" | "bank-rec" | "vat" | "general-ledger" | "trial-balance";

const categories = [
  "Income",
  "Uncategorised Expense",
  "Review Required",
  "Bank Charges",
  "Staff Welfare / Meals / Entertainment",
  "Software Subscriptions",
  "Software / IT",
  "Insurance",
  "Levies",
  "Salaries & Wages",
  "Inter-account Transfer",
  "Courier / Delivery",
  "Motor Vehicle Expenses",
  "VAT Control",
  "Finance Costs",
  "Rent",
  "Uncategorised",
];

const vatTreatments: Array<{ value: VatTreatment; label: string }> = [
  { value: "standard", label: "Standard VAT" },
  { value: "zero_rated", label: "Zero-rated" },
  { value: "exempt", label: "Exempt" },
  { value: "out_of_scope", label: "Out of scope" },
  { value: "review", label: "Review" },
];

const tabs: Array<{ id: AccountingTab; label: string }> = [
  { id: "transactions", label: "Transactions" },
  { id: "review", label: "Review Items" },
  { id: "summary", label: "Summary" },
  { id: "bank-rec", label: "Bank Reconciliation" },
  { id: "vat", label: "VAT" },
  { id: "general-ledger", label: "General Ledger" },
  { id: "trial-balance", label: "Trial Balance" },
];

function money(value: number | null) {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(value);
}

function plainNumber(value: number) {
  return new Intl.NumberFormat("en-ZA").format(value);
}

function statusLabel(status: AccountingStatementRun["status"]) {
  const labels: Record<AccountingStatementRun["status"], string> = {
    queued: "Queued",
    processing: "Processing",
    review: "Review required",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[status];
}

function statusTone(status: AccountingStatementRun["status"]) {
  const tones: Record<AccountingStatementRun["status"], string> = {
    queued: "bg-slate-100 text-slate-700",
    processing: "bg-blue-50 text-blue-700",
    review: "bg-amber-50 text-amber-700",
    completed: "bg-emerald-50 text-emerald-700",
    failed: "bg-rose-50 text-rose-700",
    cancelled: "bg-slate-100 text-slate-500",
  };
  return tones[status];
}

function compactDateTime(value: string) {
  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fileNameFromPath(path: string) {
  return path.split("/").pop() ?? "FNB statement.pdf";
}

function formatApiError(data: { error?: string; workerDetail?: unknown; workerRawBody?: string; workerStatus?: number }, fallback: string) {
  const detail =
    data.workerDetail && typeof data.workerDetail === "object" && "message" in data.workerDetail
      ? String((data.workerDetail as { message?: unknown }).message)
      : data.error;

  if (detail?.toLowerCase().includes("parser validation failed")) {
    return "Parser validation failed. The statement layout needs review.";
  }

  if (data.workerStatus) {
    return `${detail || fallback} Worker HTTP ${data.workerStatus}.`;
  }

  return detail || fallback;
}

function formatDiagnostics(data: { workerDetail?: unknown; workerRawBody?: string; workerStatus?: number }) {
  return JSON.stringify(
    {
      workerStatus: data.workerStatus,
      workerDetail: data.workerDetail,
      workerRawBody: data.workerRawBody,
    },
    null,
    2,
  );
}

function getReviewItems(transactions: AccountingTransaction[]) {
  return transactions.filter(
    (transaction) =>
      transaction.reviewStatus === "needs_review" ||
      transaction.vatTreatment === "review" ||
      transaction.accountCategory === "Review Required" ||
      transaction.accountCategory === "Uncategorised Expense" ||
      transaction.confidence < 80,
  );
}

export function AccountingIntelligence() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [runs, setRuns] = useState<AccountingStatementRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<AccountingRunDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [activeTab, setActiveTab] = useState<AccountingTab>("transactions");
  const [query, setQuery] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);

  async function loadRuns(preferredRunId?: string) {
    const response = await fetch("/api/accounting/fnb/runs");
    const data = (await response.json().catch(() => ({}))) as { runs?: AccountingStatementRun[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Unable to load accounting runs.");
    setRuns(data.runs ?? []);
    const nextRunId = preferredRunId ?? selectedRunId ?? data.runs?.[0]?.id ?? "";
    setSelectedRunId(nextRunId);
    if (nextRunId) await loadRunDetail(nextRunId);
  }

  async function loadRunDetail(runId: string) {
    const response = await fetch(`/api/accounting/fnb/runs/${runId}`);
    const data = (await response.json().catch(() => ({}))) as AccountingRunDetail & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Unable to load accounting run.");
    setDetail({ run: data.run, transactions: data.transactions });
  }

  useEffect(() => {
    void loadRuns().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to load Accounting Intelligence."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadFile(file: File) {
    setBusy("upload");
    setError("");
    setDiagnostics("");
    setMessage("");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/accounting/fnb/upload", { method: "POST", body: formData });
      const data = (await response.json().catch(() => ({}))) as { run?: AccountingStatementRun; error?: string };
      if (!response.ok || !data.run) throw new Error(data.error ?? "Upload failed.");
      setMessage("FNB statement uploaded. Accounting job queued.");
      await loadRuns(data.run.id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusy("");
    }
  }

  async function processRun(runId: string) {
    setBusy(`process:${runId}`);
    setError("");
    setDiagnostics("");
    setMessage("");

    try {
      const response = await fetch("/api/accounting/fnb/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        result?: { status?: AccountingStatementRun["status"]; review_issue?: { message?: string; errors?: string[] } };
        workerDetail?: unknown;
        workerRawBody?: string;
        workerStatus?: number;
      };
      if (!response.ok) {
        setDiagnostics(formatDiagnostics(data));
        throw new Error(formatApiError(data, "Processing failed."));
      }
      if (data.result?.status === "review") {
        setMessage(data.result.review_issue?.message ?? "FNB statement processed as a draft. Review the balance gap and extracted transactions.");
      } else {
        setMessage("FNB statement processed. Review the extracted transactions.");
      }
      await loadRuns(runId);
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : "Processing failed.");
      await loadRuns(runId).catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  async function patchTransaction(transaction: AccountingTransaction, patch: AccountingTransactionPatch) {
    setError("");
    setDiagnostics("");
    const previous = detail;
    if (previous) {
      setDetail({
        ...previous,
        transactions: previous.transactions.map((item) => (item.id === transaction.id ? { ...item, ...patch } : item)),
      });
    }

    try {
      const response = await fetch(`/api/accounting/fnb/transactions/${transaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await response.json().catch(() => ({}))) as { transaction?: AccountingTransaction; error?: string };
      if (!response.ok || !data.transaction) throw new Error(data.error ?? "Could not save transaction.");
      if (detail) {
        setDetail({
          ...detail,
          transactions: detail.transactions.map((item) => (item.id === transaction.id ? data.transaction! : item)),
        });
      }
    } catch (saveError) {
      if (previous) setDetail(previous);
      setError(saveError instanceof Error ? saveError.message : "Could not save transaction.");
    }
  }

  const transactions = detail?.transactions ?? [];
  const reviewItems = useMemo(() => getReviewItems(transactions), [transactions]);
  const selectedRows = activeTab === "review" ? reviewItems : transactions;
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return selectedRows;
    return selectedRows.filter((transaction) =>
      [transaction.transactionDate, transaction.description, transaction.accountCategory, transaction.vatTreatment, transaction.notes]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery)),
    );
  }, [query, selectedRows]);

  const totals = useMemo(() => {
    return {
      debit: transactions.reduce((sum, transaction) => sum + (transaction.debitAmount ?? 0), 0),
      credit: transactions.reduce((sum, transaction) => sum + (transaction.creditAmount ?? 0), 0),
      bankCharges: transactions.reduce((sum, transaction) => sum + (transaction.bankCharge ? transaction.debitAmount ?? 0 : 0), 0),
      review: reviewItems.length,
    };
  }, [reviewItems.length, transactions]);

  const expectedClosing = (detail?.run.openingBalance ?? 0) + totals.credit - totals.debit;
  const recDifference = expectedClosing - (detail?.run.closingBalance ?? 0);

  const accountRows = useMemo(() => {
    const groups = new Map<string, { debit: number; credit: number; count: number }>();
    for (const transaction of transactions) {
      const key = transaction.accountCategory || "Uncategorised";
      const current = groups.get(key) ?? { debit: 0, credit: 0, count: 0 };
      current.debit += transaction.debitAmount ?? 0;
      current.credit += transaction.creditAmount ?? 0;
      current.count += 1;
      groups.set(key, current);
    }
    return Array.from(groups, ([account, values]) => ({ account, ...values })).sort((a, b) => a.account.localeCompare(b.account));
  }, [transactions]);

  const vatRows = useMemo(() => {
    const groups = new Map<VatTreatment, { debit: number; credit: number; count: number }>();
    for (const transaction of transactions) {
      const current = groups.get(transaction.vatTreatment) ?? { debit: 0, credit: 0, count: 0 };
      current.debit += transaction.debitAmount ?? 0;
      current.credit += transaction.creditAmount ?? 0;
      current.count += 1;
      groups.set(transaction.vatTreatment, current);
    }
    return Array.from(groups, ([vatTreatment, values]) => ({ vatTreatment, ...values }));
  }, [transactions]);

  const selectedCompany = detail?.run.companyName || selectedRun?.companyName || "ALLIANZ HOLDINGS (PTY) LTD";
  const selectedAccount = detail?.run.accountNumber || selectedRun?.accountNumber || "63012589818";

  return (
    <div className="space-y-5 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-bold text-slate-500">Accounting Intelligence <span className="mx-2 text-slate-300">›</span> FNB Statements</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-navy-950 sm:text-3xl">FNB statement accounting engine</h1>
        </div>
        <label className="relative block w-full max-w-xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transactions, tags, accounts..."
            className="h-12 w-full rounded-2xl border border-slate-200 bg-white pl-11 pr-12 text-sm font-semibold text-navy-950 shadow-sm outline-none transition focus:border-royal-300 focus:ring-4 focus:ring-royal-100"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-black text-slate-400">⌘K</span>
        </label>
      </header>

      <section
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files.item(0);
          if (file) void uploadFile(file);
        }}
        className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="grid gap-6 xl:grid-cols-[1fr_460px] xl:items-center">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-royal-600">Accounting Intelligence</p>
            <h2 className="mt-2 text-2xl font-black text-navy-950">Upload an FNB business bank statement PDF</h2>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-600">
              Extract transactions, review accounting treatment, reconcile bank movement and export a structured Excel workpaper.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-2 block text-xs font-black text-slate-500">Bank</span>
              <select
                value="FNB South Africa"
                disabled
                className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-black text-navy-950"
              >
                <option>FNB South Africa</option>
              </select>
            </label>
            <div className="rounded-3xl bg-royal-50 p-4 text-center">
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void uploadFile(file);
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                disabled={busy === "upload"}
                onClick={() => inputRef.current?.click()}
                className="inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-2xl bg-royal-600 px-5 text-sm font-black text-white shadow-glow transition hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Upload FNB PDF
              </button>
              <p className="mt-3 text-xs font-semibold text-slate-500">PDF up to 200 MB · drag and drop supported</p>
            </div>
          </div>
        </div>
      </section>

      {message ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{message}</div> : null}
      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
          <p>{error}</p>
          {diagnostics ? (
            <details className="mt-3 rounded-xl border border-rose-200 bg-white/70 p-3 text-xs font-semibold text-rose-900">
              <summary className="cursor-pointer">Developer diagnostics</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{diagnostics}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.8fr_1fr_1fr_1fr_1fr_1fr_1fr]">
        <SummaryCard
          wide
          icon={<Building2 className="h-7 w-7" />}
          label={selectedCompany}
          value={selectedAccount}
          subvalue="Business Account"
        />
        <SummaryCard
          label="Statement status"
          value={detail ? statusLabel(detail.run.status) : "No statement"}
          subvalue={`Confidence: ${detail ? Math.round(detail.run.confidence) : 0}%`}
          warning={detail?.run.status === "review" || detail?.run.status === "failed"}
        />
        <SummaryCard label="Opening balance" value={money(detail?.run.openingBalance ?? null)} />
        <SummaryCard label="Closing balance" value={money(detail?.run.closingBalance ?? null)} />
        <SummaryCard label="Debits" value={money(transactions.length ? totals.debit : null)} danger />
        <SummaryCard label="Credits" value={money(transactions.length ? totals.credit : null)} success />
        <SummaryCard label="Review items" value={plainNumber(totals.review)} subvalue={totals.review ? "Needs attention" : "Clear"} warning={totals.review > 0} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <StatementRuns
          runs={runs}
          selectedRunId={selectedRunId}
          onRefresh={() => void loadRuns().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Refresh failed."))}
          onSelect={(runId) => {
            setSelectedRunId(runId);
            setActiveTab("transactions");
            void loadRunDetail(runId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to open run."));
          }}
        />

        <section className="min-w-0 rounded-[1.75rem] border border-slate-200 bg-white shadow-sm">
          {selectedRun && detail ? (
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-black text-navy-950">{fileNameFromPath(detail.run.sourceStoragePath)}</h2>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-black ${statusTone(detail.run.status)}`}>{statusLabel(detail.run.status)}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    {detail.run.transactionCount || detail.transactions.length} transactions · {totals.review} review items
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy === `process:${detail.run.id}` || detail.run.status === "processing"}
                    onClick={() => void processRun(detail.run.id)}
                    className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-black text-navy-950 hover:border-royal-200 hover:text-royal-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {busy === `process:${detail.run.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                    Re-run extraction
                  </button>
                  <button
                    type="button"
                    disabled
                    title="Deleting statement runs is coming soon."
                    className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-2xl border border-rose-100 bg-rose-50 px-4 text-sm font-black text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </button>
                  <ExportDropdown run={detail.run} reviewCount={totals.review} open={exportOpen} onOpenChange={setExportOpen} />
                </div>
              </div>

              {detail.run.status === "review" && detail.run.error ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
                  <p>{detail.run.error}</p>
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    A draft workbook and extracted transactions are available. Review highlighted rows before using the final accounting pack.
                  </p>
                </div>
              ) : null}

              <div className="overflow-x-auto border-b border-slate-200">
                <div className="flex min-w-max gap-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`border-b-2 px-3 py-3 text-sm font-black transition ${
                        activeTab === tab.id ? "border-royal-600 text-royal-700" : "border-transparent text-slate-500 hover:text-navy-950"
                      }`}
                    >
                      {tab.label}
                      {tab.id === "review" ? ` (${totals.review})` : ""}
                    </button>
                  ))}
                </div>
              </div>

              {activeTab === "transactions" || activeTab === "review" ? (
                <>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <label className="relative block w-full max-w-md">
                      <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search transactions..."
                        className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-11 pr-4 text-sm font-semibold outline-none focus:border-royal-300"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled
                        title="Advanced filters are coming soon."
                        className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-black text-slate-400"
                      >
                        <Filter className="h-4 w-4" />
                        Filter
                      </button>
                      <button
                        type="button"
                        disabled
                        title="Column customization is coming soon."
                        className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-black text-slate-400"
                      >
                        Columns
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <TransactionTable transactions={filteredRows} patchTransaction={patchTransaction} />
                </>
              ) : null}

              {activeTab === "summary" ? <SummaryPanel run={detail.run} totals={totals} transactionCount={transactions.length} /> : null}
              {activeTab === "bank-rec" ? (
                <BankRecPanel run={detail.run} totals={totals} expectedClosing={expectedClosing} difference={recDifference} />
              ) : null}
              {activeTab === "vat" ? <VatPanel rows={vatRows} /> : null}
              {activeTab === "general-ledger" ? <GeneralLedgerPanel rows={accountRows} /> : null}
              {activeTab === "trial-balance" ? <TrialBalancePanel rows={accountRows} /> : null}
            </div>
          ) : (
            <EmptyWorkspace />
          )}
        </section>
      </div>
    </div>
  );
}

function ExportDropdown({
  run,
  reviewCount,
  open,
  onOpenChange,
}: {
  run: AccountingStatementRun;
  reviewCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const options = [
    { label: "Export Transactions", section: "transactions", detail: "CSV transaction listing" },
    { label: `Export Review Items (${reviewCount})`, section: "review-items", detail: "Rows requiring accountant review" },
    { label: "Export Summary", section: "summary", detail: "Statement summary metrics" },
    { label: "Export Bank Reconciliation", section: "bank-reconciliation", detail: "Opening, receipts, payments and closing check" },
    { label: "Export VAT", section: "vat", detail: "VAT treatment schedule" },
    { label: "Export General Ledger", section: "general-ledger", detail: "Account movement summary" },
    { label: "Export Trial Balance", section: "trial-balance", detail: "Debit and credit balances" },
    { label: "Export All in a single file", section: "all", detail: "All sections in one Excel file", requiresWorkbook: true },
  ];

  return (
    <div className="relative">
      <button
        type="button"
        disabled={!run.workbookStoragePath}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-11 items-center gap-2 rounded-2xl bg-royal-600 px-4 text-sm font-black text-white hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ArrowDownToLine className="h-4 w-4" />
        Export
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-xl" role="menu">
          <p className="px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">Export options</p>
          {options.map((option, index) => (
            <a
              key={option.section}
              href={`/api/accounting/fnb/export/${run.id}${option.section === "all" ? "" : `?section=${option.section}`}`}
              onClick={() => onOpenChange(false)}
              className={`flex items-start gap-3 rounded-xl px-3 py-3 text-sm font-black text-navy-950 hover:bg-royal-50 ${
                index === options.length - 1 ? "mt-2 border-t border-slate-100 pt-4" : ""
              }`}
              role="menuitem"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <span>
                {option.label}
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">{option.detail}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  subvalue,
  icon,
  wide = false,
  danger = false,
  success = false,
  warning = false,
}: {
  label: string;
  value: string;
  subvalue?: string;
  icon?: ReactNode;
  wide?: boolean;
  danger?: boolean;
  success?: boolean;
  warning?: boolean;
}) {
  return (
    <div className={`rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ${wide ? "md:col-span-2 xl:col-span-1" : ""}`}>
      <div className="flex items-center gap-4">
        {icon ? <div className="rounded-2xl bg-royal-50 p-3 text-royal-600">{icon}</div> : null}
        <div className="min-w-0">
          <p className="text-xs font-black text-slate-500">{label}</p>
          <p className={`mt-2 truncate text-lg font-black ${danger ? "text-rose-700" : success ? "text-emerald-700" : warning ? "text-amber-700" : "text-navy-950"}`}>
            {value}
          </p>
          {subvalue ? <p className="mt-1 text-xs font-black text-slate-500">{subvalue}</p> : null}
        </div>
        {warning ? <AlertTriangle className="ml-auto h-5 w-5 text-amber-500" /> : null}
      </div>
    </div>
  );
}

function StatementRuns({
  runs,
  selectedRunId,
  onRefresh,
  onSelect,
}: {
  runs: AccountingStatementRun[];
  selectedRunId: string;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
}) {
  return (
    <section className="rounded-[1.75rem] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-navy-950">Statement runs</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">Uploaded FNB statements and processing state.</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:text-royal-700"
          aria-label="Refresh accounting runs"
        >
          <RefreshCcw className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3">
        {runs.length ? (
          runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelect(run.id)}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                selectedRunId === run.id ? "border-royal-300 bg-royal-50 ring-4 ring-royal-50" : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-rose-50 p-2 text-rose-600">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-black text-navy-950">{fileNameFromPath(run.sourceStoragePath)}</p>
                    <MoreVertical className="h-4 w-4 shrink-0 text-slate-400" />
                  </div>
                  <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-black ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className="text-xs font-bold text-slate-500">{compactDateTime(run.createdAt)}</p>
                    <p className="text-right text-xs font-bold text-slate-500">
                      Confidence
                      <span className="ml-1 text-base font-black text-slate-700">{Math.round(run.confidence)}%</span>
                    </p>
                  </div>
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
            No FNB statements uploaded yet.
          </div>
        )}
      </div>
    </section>
  );
}

function TransactionTable({
  transactions,
  patchTransaction,
}: {
  transactions: AccountingTransaction[];
  patchTransaction: (transaction: AccountingTransaction, patch: AccountingTransactionPatch) => Promise<void>;
}) {
  if (!transactions.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
        <FileSpreadsheet className="mx-auto h-8 w-8 text-royal-500" />
        <p className="mt-3 font-black text-navy-950">No transactions in this view</p>
        <p className="mt-1 text-sm text-slate-500">Process a statement or adjust the search filter.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <table className="w-full min-w-[1220px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-black text-slate-500">
          <tr>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Description</th>
            <th className="px-4 py-3">Money In (R)</th>
            <th className="px-4 py-3">Money Out (R)</th>
            <th className="px-4 py-3">Balance (R)</th>
            <th className="px-4 py-3">Bank Charge (R)</th>
            <th className="px-4 py-3">Account</th>
            <th className="px-4 py-3">VAT</th>
            <th className="px-4 py-3">Review</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {transactions.map((transaction) => (
            <tr key={transaction.id} className="align-middle hover:bg-slate-50/70">
              <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-600">{transaction.transactionDate || "-"}</td>
              <td className="max-w-[300px] px-4 py-3">
                <p className="font-black leading-5 text-navy-950">{transaction.description}</p>
                <p className="mt-1 text-xs font-bold text-slate-400">Confidence {Math.round(transaction.confidence)}%</p>
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-black text-emerald-700">{money(transaction.creditAmount)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-black text-rose-700">{money(transaction.debitAmount)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-bold text-navy-950">{money(transaction.runningBalance)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-600">{transaction.bankCharge ? money(transaction.debitAmount) : "-"}</td>
              <td className="px-4 py-3">
                <select
                  value={transaction.accountCategory}
                  onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                  className="w-48 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-navy-950 outline-none focus:border-royal-300"
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">
                <select
                  value={transaction.vatTreatment}
                  onChange={(event) => void patchTransaction(transaction, { vatTreatment: event.target.value as VatTreatment })}
                  className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-navy-950 outline-none focus:border-royal-300"
                >
                  {vatTreatments.map((treatment) => (
                    <option key={treatment.value} value={treatment.value}>
                      {treatment.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() =>
                    void patchTransaction(transaction, {
                      reviewStatus: transaction.reviewStatus === "approved" ? "needs_review" : "approved",
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black ${
                    transaction.reviewStatus === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {transaction.reviewStatus === "approved" ? <BadgeCheck className="h-3 w-3" /> : <PencilLine className="h-3 w-3" />}
                  {transaction.reviewStatus === "approved" ? "Approved" : "Review"}
                </button>
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  disabled
                  title="Row action menu is coming soon."
                  className="rounded-xl border border-slate-200 p-2 text-slate-300"
                  aria-label={`Actions for ${transaction.description}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryPanel({
  run,
  totals,
  transactionCount,
}: {
  run: AccountingStatementRun;
  totals: { debit: number; credit: number; bankCharges: number; review: number };
  transactionCount: number;
}) {
  const rows: Array<[string, string]> = [
    ["Company", run.companyName || "-"],
    ["Account number", run.accountNumber || "-"],
    ["Statement period", [run.statementPeriodStart, run.statementPeriodEnd].filter(Boolean).join(" to ") || "-"],
    ["Opening balance", money(run.openingBalance)],
    ["Total receipts", money(totals.credit)],
    ["Total payments", money(totals.debit)],
    ["Closing balance", money(run.closingBalance)],
    ["Transactions extracted", plainNumber(transactionCount)],
    ["Review items", plainNumber(totals.review)],
  ];
  return <KeyValuePanel title="Statement summary" rows={rows} />;
}

function BankRecPanel({
  run,
  totals,
  expectedClosing,
  difference,
}: {
  run: AccountingStatementRun;
  totals: { debit: number; credit: number; bankCharges: number; review: number };
  expectedClosing: number;
  difference: number;
}) {
  const rows: Array<[string, string]> = [
    ["Opening Balance", money(run.openingBalance)],
    ["+ Receipts", money(totals.credit)],
    ["- Payments", money(totals.debit)],
    ["= Expected Closing Balance", money(expectedClosing)],
    ["Statement Closing Balance", money(run.closingBalance)],
    ["Difference", money(difference)],
    ["Status", Math.abs(difference) < 0.01 ? "Reconciled" : "Needs review"],
    ["Service Fees", money(totals.bankCharges)],
    ["Bank VAT", run.bankChargesTotal ? money(run.bankChargesTotal * (15 / 115)) : "-"],
  ];
  return <KeyValuePanel title="Bank reconciliation" rows={rows} />;
}

function VatPanel({ rows }: { rows: Array<{ vatTreatment: VatTreatment; debit: number; credit: number; count: number }> }) {
  return (
    <SimpleTable
      title="VAT schedule"
      headers={["VAT treatment", "Transactions", "Money in", "Money out"]}
      rows={rows.map((row) => [vatTreatments.find((item) => item.value === row.vatTreatment)?.label ?? row.vatTreatment, plainNumber(row.count), money(row.credit), money(row.debit)])}
    />
  );
}

function GeneralLedgerPanel({ rows }: { rows: Array<{ account: string; debit: number; credit: number; count: number }> }) {
  return (
    <SimpleTable
      title="General ledger summary"
      headers={["Account", "Transactions", "Debits", "Credits", "Net movement"]}
      rows={rows.map((row) => [row.account, plainNumber(row.count), money(row.debit), money(row.credit), money(row.credit - row.debit)])}
    />
  );
}

function TrialBalancePanel({ rows }: { rows: Array<{ account: string; debit: number; credit: number; count: number }> }) {
  const totals = rows.reduce(
    (sum, row) => {
      const balance = row.debit - row.credit;
      sum.debit += balance > 0 ? balance : 0;
      sum.credit += balance < 0 ? Math.abs(balance) : 0;
      return sum;
    },
    { debit: 0, credit: 0 },
  );
  const body = rows.map((row) => {
    const balance = row.debit - row.credit;
    return [row.account, money(row.debit), money(row.credit), balance > 0 ? money(balance) : "-", balance < 0 ? money(Math.abs(balance)) : "-"];
  });
  body.push(["Totals", "-", "-", money(totals.debit), money(totals.credit)]);
  return <SimpleTable title="Trial balance" headers={["Account", "Total Debits", "Total Credits", "Debit Balance", "Credit Balance"]} rows={body} />;
}

function KeyValuePanel({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-2xl border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h3 className="font-black text-navy-950">{title}</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-2 px-4 py-3 sm:grid-cols-[260px_1fr]">
            <p className="text-sm font-black text-slate-500">{label}</p>
            <p className="text-sm font-black text-navy-950">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimpleTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <div className="space-y-3">
      <h3 className="font-black text-navy-950">{title}</h3>
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-black text-slate-500">
            <tr>
              {headers.map((header) => (
                <th key={header} className="px-4 py-3">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={`${row[0]}-${index}`} className={index === rows.length - 1 && row[0] === "Totals" ? "bg-slate-50 font-black" : ""}>
                {row.map((cell, cellIndex) => (
                  <td key={`${cell}-${cellIndex}`} className="px-4 py-3 font-semibold text-navy-950">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <div className="p-6">
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-royal-50 text-royal-600">
          <Banknote className="h-7 w-7" />
        </div>
        <p className="mt-4 text-lg font-black text-navy-950">Select or upload an FNB statement</p>
        <p className="mx-auto mt-2 max-w-md text-sm font-medium text-slate-500">The accounting workspace appears once a statement run exists.</p>
      </div>
    </div>
  );
}

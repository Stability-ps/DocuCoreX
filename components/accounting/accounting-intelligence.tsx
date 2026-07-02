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
  PackageCheck,
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
type UploadQueueStatus = "Queued" | "Uploading" | "Uploaded" | "Processing" | "Completed" | "Needs Review" | "Failed";
type UploadQueueItem = {
  id: string;
  name: string;
  size: number;
  status: UploadQueueStatus;
  runId?: string;
  error?: string;
  file?: File;
};

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

const supportedBanks = [
  { name: "FNB", active: true },
  { name: "ABSA", active: false },
  { name: "Nedbank", active: false },
  { name: "Standard Bank", active: false },
  { name: "Capitec", active: false },
  { name: "Investec", active: false },
];

function money(value: number | null) {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(value);
}

function plainNumber(value: number) {
  return new Intl.NumberFormat("en-ZA").format(value);
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
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

function runDisplayTitle(run: AccountingStatementRun) {
  const source = run.statementPeriodStart || run.createdAt;
  const date = new Date(source);
  const month = new Intl.DateTimeFormat("en-ZA", { month: "long" }).format(date);
  const year = new Intl.DateTimeFormat("en-ZA", { year: "numeric" }).format(date);
  return `${month} ${year} Statement`;
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

function runAccountKey(run: AccountingStatementRun) {
  return [run.companyName?.trim().toLowerCase() ?? "", run.bank.trim().toLowerCase(), run.accountNumber?.trim().toLowerCase() ?? ""].join("|");
}

function fileNameFromContentDisposition(header: string | null) {
  if (!header) return null;
  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encodedMatch?.[1]) return decodeURIComponent(encodedMatch[1]);
  const plainMatch = /filename="?([^";]+)"?/i.exec(header);
  if (plainMatch?.[1]) return plainMatch[1];
  return null;
}

type CombineOverrideType = "account" | "continuity";

export function AccountingIntelligence() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [runs, setRuns] = useState<AccountingStatementRun[]>([]);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<AccountingRunDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [activeTab, setActiveTab] = useState<AccountingTab>("transactions");
  const [query, setQuery] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [runSort, setRunSort] = useState("newest");
  const [exportOpen, setExportOpen] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideType, setOverrideType] = useState<CombineOverrideType>("account");
  const [overrideText, setOverrideText] = useState("");
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

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    const items = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      status: "Queued" as const,
      file,
    }));
    setUploadQueue((queue) => [...items, ...queue]);

    for (const item of items) {
      setUploadQueue((queue) => queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Uploading", error: undefined } : queuedItem)));
      const run = await uploadFile(item.file, item.id);
      if (run) {
        setUploadQueue((queue) =>
          queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Uploaded", runId: run.id, file: undefined } : queuedItem)),
        );
      }
    }
  }

  async function uploadFile(file: File, queueItemId?: string) {
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
      setMessage("FNB statement uploaded and queued for extraction.");
      await loadRuns(data.run.id);
      return data.run;
    } catch (uploadError) {
      if (queueItemId) {
        setUploadQueue((queue) =>
          queue.map((item) =>
            item.id === queueItemId ? { ...item, status: "Failed", error: uploadError instanceof Error ? uploadError.message : "Upload failed.", file } : item,
          ),
        );
      }
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function retryUpload(item: UploadQueueItem) {
    if (!item.file) return;
    setUploadQueue((queue) => queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Queued", error: undefined } : queuedItem)));
    const run = await uploadFile(item.file, item.id);
    if (run) {
      setUploadQueue((queue) =>
        queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Uploaded", runId: run.id, file: undefined } : queuedItem)),
      );
    }
  }

  async function processQueueItem(item: UploadQueueItem) {
    if (!item.runId) return;
    setUploadQueue((queue) => queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Processing", error: undefined } : queuedItem)));

    const response = await fetch("/api/accounting/fnb/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: item.runId }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      result?: { status?: AccountingStatementRun["status"] };
    };

    if (!response.ok) {
      setUploadQueue((queue) =>
        queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: "Failed", error: data.error ?? "Processing failed." } : queuedItem)),
      );
      return;
    }

    const nextStatus = data.result?.status === "review" ? "Needs Review" : data.result?.status === "completed" ? "Completed" : "Uploaded";
    setUploadQueue((queue) => queue.map((queuedItem) => (queuedItem.id === item.id ? { ...queuedItem, status: nextStatus } : queuedItem)));
  }

  async function processUploadedQueue() {
    const items = uploadQueue.filter((item) => item.runId && item.status === "Uploaded");
    if (!items.length) return;
    setBusy("queue-process");
    setError("");
    setMessage("");
    try {
      for (const item of items) {
        await processQueueItem(item);
      }
      setMessage("Uploaded statements processed. Select completed statements to create a combined workbook.");
      await loadRuns(items[0]?.runId);
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Queue processing failed.");
    } finally {
      setBusy("");
    }
  }

  function selectReadyQueueRuns() {
    const readyIds = uploadQueue
      .filter((item) => item.runId && (item.status === "Completed" || item.status === "Needs Review"))
      .map((item) => item.runId as string);
    if (!readyIds.length) return;
    setSelectedRunIds((current) => Array.from(new Set([...current, ...readyIds])));
    setMessage("Ready statements selected for combined workbook.");
  }

  async function createCombinedWorkbook(options?: { combineDifferentAccounts?: boolean; overrideContinuity?: boolean; confirmationText?: string }) {
    setBusy("combine");
    setError("");
    setMessage("");
    setDiagnostics("");
    try {
      const response = await fetch("/api/accounting/fnb/combine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runIds: selectedRunIds,
          combineDifferentAccounts: Boolean(options?.combineDifferentAccounts),
          overrideContinuity: Boolean(options?.overrideContinuity),
          confirmationText: options?.confirmationText,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          status?: string;
          allowOverride?: boolean;
        };
        if (data.status === "review_required" && data.allowOverride) {
          setOverrideType("continuity");
          setOverrideText("");
          setOverrideDialogOpen(true);
        }
        throw new Error(data.error ?? data.message ?? "Combined workbook generation failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameFromContentDisposition(response.headers.get("Content-Disposition")) ?? "FNB-combined-accounting-pack.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("Combined workbook generated.");
    } catch (combineError) {
      setError(combineError instanceof Error ? combineError.message : "Combined workbook generation failed.");
    } finally {
      setBusy("");
    }
  }

  async function createCombinedWorkbookWithPrecheck() {
    const selectedRuns = runs.filter((run) => selectedRunIds.includes(run.id));
    const keys = new Set(selectedRuns.map(runAccountKey));
    if (keys.size > 1) {
      setOverrideType("account");
      setOverrideText("");
      setOverrideDialogOpen(true);
      return;
    }
    await createCombinedWorkbook();
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

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:space-y-5 lg:p-8">
      <header className="flex flex-col gap-2 md:gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="hidden text-sm font-bold text-slate-500 md:block">Accounting Intelligence <span className="mx-2 text-slate-300">›</span> Bank Statements</p>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 md:mt-2 sm:text-3xl md:hidden">Accounting</h1>
          <h1 className="mt-2 hidden text-2xl font-semibold tracking-tight text-navy-950 sm:text-3xl md:block">Bank statement accounting engine</h1>
          <p className="mt-1 text-sm font-semibold text-slate-500 md:hidden">Bank statement extraction & accounting workpapers</p>
        </div>
        <label className="relative hidden w-full max-w-xl md:block">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transactions, tags, accounts..."
            className="h-12 w-full rounded-lg border border-slate-200 bg-white pl-11 pr-12 text-sm font-semibold text-navy-950 shadow-sm outline-none transition focus:border-royal-300 focus:ring-4 focus:ring-royal-100"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">⌘K</span>
        </label>
      </header>

      <section
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void uploadFiles(Array.from(event.dataTransfer.files));
        }}
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6"
      >
        <div className="grid gap-4 xl:grid-cols-[1fr_460px] xl:items-center">
          <div className="hidden md:block">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-royal-600">Accounting Intelligence</p>
            <h2 className="mt-2 text-2xl font-semibold text-navy-950">Upload a business bank statement PDF</h2>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-600">
              Extract transactions, review accounting treatment, reconcile bank movement and export a structured Excel workpaper.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-500">Select Bank</span>
              <select
                value="FNB South Africa"
                disabled
                className="h-12 w-full rounded-lg border border-slate-200 bg-slate-50 px-4 text-base font-semibold text-navy-950 md:text-sm"
              >
                <option>FNB South Africa</option>
              </select>
            </label>
            <div className="rounded-xl bg-royal-50 p-3 text-center md:p-4">
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="hidden"
                onChange={(event) => {
                  void uploadFiles(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                disabled={busy === "upload"}
                onClick={() => inputRef.current?.click()}
                className="inline-flex h-12 w-full min-w-44 items-center justify-center gap-2 rounded-lg bg-royal-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
              >
                {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Upload FNB PDFs
              </button>
              <p className="mt-2 text-xs font-semibold text-slate-500">PDF up to 200MB</p>
            </div>
          </div>
          <div className="xl:col-span-2">
            <p className="mb-2 text-xs font-semibold text-slate-500">Supported Banks</p>
            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
              {supportedBanks.map((bank) => (
                <span
                  key={bank.name}
                  className={`rounded-full border px-3 py-2 text-center text-xs font-black ${
                    bank.active ? "border-royal-200 bg-royal-50 text-royal-700" : "border-slate-200 bg-slate-50 text-slate-400"
                  }`}
                  title={bank.active ? "Active" : "Coming Soon"}
                >
                  {bank.name}
                  {!bank.active ? <span className="block text-[10px] font-semibold sm:inline sm:pl-1">Soon</span> : null}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {uploadQueue.length ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-navy-950">Upload queue</h2>
              <p className="text-sm font-medium text-slate-500">Multiple statements can be uploaded and processed together.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!uploadQueue.some((item) => item.status === "Uploaded" && item.runId) || busy === "queue-process"}
                onClick={() => void processUploadedQueue()}
                className="rounded-lg bg-royal-600 px-3 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {busy === "queue-process" ? "Processing..." : "Process uploaded"}
              </button>
              <button
                type="button"
                disabled={!uploadQueue.some((item) => item.runId && (item.status === "Completed" || item.status === "Needs Review"))}
                onClick={selectReadyQueueRuns}
                className="rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 ring-1 ring-slate-200 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                Select ready
              </button>
              <button type="button" onClick={() => setUploadQueue([])} className="text-xs font-black text-slate-500">
                Clear
              </button>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {uploadQueue.map((item) => (
              <div key={item.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-navy-950">{item.name}</p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">{fileSize(item.size)}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${
                      item.status === "Failed"
                        ? "bg-rose-50 text-rose-700"
                        : item.status === "Uploaded" || item.status === "Completed"
                          ? "bg-emerald-50 text-emerald-700"
                          : item.status === "Needs Review"
                            ? "bg-amber-50 text-amber-700"
                          : "bg-blue-50 text-blue-700"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                {item.status === "Uploading" || item.status === "Processing" ? (
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-royal-500" />
                  </div>
                ) : null}
                {item.status === "Uploaded" ? <p className="mt-2 text-xs font-semibold text-emerald-700">Stored and ready for extraction.</p> : null}
                {item.status === "Completed" ? <p className="mt-2 text-xs font-semibold text-emerald-700">Extraction complete. Select it for a combined workbook.</p> : null}
                {item.status === "Needs Review" ? <p className="mt-2 text-xs font-semibold text-amber-700">Extraction complete with review items.</p> : null}
                {item.error ? <p className="mt-2 text-xs font-semibold text-rose-700">{item.error}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.runId ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedRunId(item.runId ?? "");
                        setActiveTab("transactions");
                        void loadRunDetail(item.runId ?? "").catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to open run."));
                      }}
                      className="rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 shadow-sm ring-1 ring-slate-200"
                    >
                      Open run
                    </button>
                  ) : null}
                  {item.status === "Uploaded" && item.runId ? (
                    <button
                      type="button"
                      disabled={busy === "queue-process"}
                      onClick={() => void processQueueItem(item)}
                      className="rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 shadow-sm ring-1 ring-slate-200 disabled:text-slate-400"
                    >
                      Process
                    </button>
                  ) : null}
                  {item.status === "Failed" && item.file ? (
                    <button
                      type="button"
                      onClick={() => void retryUpload(item)}
                      className="rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 shadow-sm ring-1 ring-slate-200"
                    >
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setUploadQueue((queue) => queue.filter((queuedItem) => queuedItem.id !== item.id))}
                    className="rounded-lg bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm ring-1 ring-slate-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {message ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{message}</div> : null}
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
          <p>{error}</p>
          {diagnostics ? (
            <details className="mt-3 rounded-xl border border-rose-200 bg-white/70 p-3 text-xs font-semibold text-rose-900">
              <summary className="cursor-pointer">Developer diagnostics</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{diagnostics}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <SummaryCard
          label="Status"
          value={detail ? statusLabel(detail.run.status) : "No statement"}
          subvalue={`Confidence: ${detail ? Math.round(detail.run.confidence) : 0}%`}
          warning={detail?.run.status === "review" || detail?.run.status === "failed"}
        />
        <SummaryCard label="Opening balance" value={money(detail?.run.openingBalance ?? null)} />
        <SummaryCard label="Closing balance" value={money(detail?.run.closingBalance ?? null)} />
        <SummaryCard label="Debits" value={money(transactions.length ? totals.debit : null)} danger />
        <SummaryCard label="Credits" value={money(transactions.length ? totals.credit : null)} success />
        <SummaryCard label="Review" value={plainNumber(totals.review)} subvalue={totals.review ? "Needs attention" : "Clear"} warning={totals.review > 0} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <StatementRuns
          runs={runs}
          selectedRunId={selectedRunId}
          selectedRunIds={selectedRunIds}
          search={runSearch}
          sortBy={runSort}
          onToggleSelected={(runId) =>
            setSelectedRunIds((current) => (current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]))
          }
          onSearchChange={setRunSearch}
          onSortChange={setRunSort}
          onReprocess={(runId) => void processRun(runId)}
          onRefresh={() => void loadRuns().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Refresh failed."))}
          onSelect={(runId) => {
            setSelectedRunId(runId);
            setActiveTab("transactions");
            void loadRunDetail(runId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to open run."));
          }}
        />

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
          {selectedRunIds.length ? (
            <div className="border-b border-slate-200 bg-royal-50 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-black text-navy-950">{selectedRunIds.length} statements selected</p>
                  <p className="text-sm font-semibold text-slate-600">DocuCoreX will sort them by statement period and check balance continuity.</p>
                </div>
                  <button
                  type="button"
                    onClick={() => void createCombinedWorkbookWithPrecheck()}
                  disabled={selectedRunIds.length < 2 || busy === "combine"}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-royal-600 px-4 text-sm font-black text-white disabled:bg-slate-300"
                >
                  {busy === "combine" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
                  Create Combined Workbook
                </button>
              </div>
            </div>
          ) : null}
          {selectedRun && detail ? (
            <div className="space-y-4 p-4 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold text-navy-950">{runDisplayTitle(detail.run)}</h2>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(detail.run.status)}`}>{statusLabel(detail.run.status)}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    {detail.run.transactionCount || detail.transactions.length} transactions · {totals.review} review items
                  </p>
                </div>
                <div className="hidden flex-wrap gap-2 md:flex">
                  <button
                    type="button"
                    disabled={busy === `process:${detail.run.id}` || detail.run.status === "processing"}
                    onClick={() => void processRun(detail.run.id)}
                    className="inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-navy-950 hover:border-royal-200 hover:text-royal-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {busy === `process:${detail.run.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                    Re-run extraction
                  </button>
                  <button
                    type="button"
                    disabled
                    title="Deleting statement runs is coming soon."
                    className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-lg border border-rose-100 bg-rose-50 px-4 text-sm font-semibold text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </button>
                  <ExportDropdown run={detail.run} reviewCount={totals.review} open={exportOpen} onOpenChange={setExportOpen} />
                </div>
              </div>

              {detail.run.status === "review" && detail.run.error ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
                  <p>{detail.run.error}</p>
                  <p className="mt-1 text-xs font-semibold text-amber-800">
                    A draft workbook and extracted transactions are available. Review highlighted rows before using the final accounting pack.
                  </p>
                </div>
              ) : null}

              <div className="-mx-4 overflow-x-auto border-b border-slate-200 px-4 md:mx-0 md:px-0">
                <div className="flex min-w-max gap-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`border-b-2 px-3 py-3 text-sm font-semibold transition ${
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
                        className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-11 pr-4 text-base font-semibold outline-none focus:border-royal-300 md:text-sm"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled
                        title="Advanced filters are coming soon."
                        className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-400"
                      >
                        <Filter className="h-4 w-4" />
                        Filter
                      </button>
                      <button
                        type="button"
                        disabled
                        title="Column customization is coming soon."
                        className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-400"
                      >
                        Columns
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <MobileTransactionCards transactions={filteredRows} patchTransaction={patchTransaction} reviewMode={activeTab === "review"} />
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
      {overrideDialogOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end bg-slate-950/40 p-3 sm:items-center sm:justify-center">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-navy-950">Confirm Combined Workbook Override</h3>
            <p className="mt-2 text-sm font-medium text-slate-600">
              {overrideType === "account"
                ? "The selected statements belong to different accounts. Do you want to combine them anyway?"
                : "Continuity checks failed between one or more selected statements. Do you want to combine them anyway?"}
            </p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Type COMBINE to continue</p>
            <input
              value={overrideText}
              onChange={(event) => setOverrideText(event.target.value)}
              placeholder="COMBINE"
              className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setOverrideDialogOpen(false);
                  setOverrideText("");
                }}
                className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={overrideText.trim().toUpperCase() !== "COMBINE" || busy === "combine"}
                onClick={() => {
                  setOverrideDialogOpen(false);
                  void createCombinedWorkbook({
                    combineDifferentAccounts: overrideType === "account",
                    overrideContinuity: overrideType === "continuity",
                    confirmationText: overrideText.trim(),
                  });
                }}
                className="min-h-11 flex-1 rounded-xl bg-royal-600 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                Combine Anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {detail ? (
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 grid grid-cols-3 gap-2 border-t border-slate-200 bg-white/95 p-3 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur-xl md:hidden">
          <ExportDropdown run={detail.run} reviewCount={totals.review} open={exportOpen} onOpenChange={setExportOpen} mobile />
          <button
            type="button"
            onClick={() => setActiveTab("review")}
            className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-black text-navy-950"
          >
            Review
          </button>
          <button
            type="button"
            onClick={() => void processRun(detail.run.id)}
            disabled={busy === `process:${detail.run.id}` || detail.run.status === "processing"}
            className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-black text-navy-950 disabled:text-slate-300"
          >
            More
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ExportDropdown({
  run,
  reviewCount,
  open,
  onOpenChange,
  mobile = false,
}: {
  run: AccountingStatementRun;
  reviewCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mobile?: boolean;
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
        className={`${mobile ? "h-11 w-full justify-center rounded-xl" : "h-11 rounded-lg px-4"} inline-flex items-center gap-2 bg-royal-600 text-sm font-semibold text-white hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ArrowDownToLine className="h-4 w-4" />
        Export
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div className={`${mobile ? "fixed inset-x-3 bottom-[calc(9.5rem+env(safe-area-inset-bottom))]" : "absolute right-0 mt-2 w-80"} z-50 overflow-hidden rounded-lg border border-slate-200 bg-white p-2 shadow-xl`} role="menu">
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Export options</p>
          {options.map((option, index) => (
            <a
              key={option.section}
              href={`/api/accounting/fnb/export/${run.id}${option.section === "all" ? "" : `?section=${option.section}`}`}
              onClick={() => onOpenChange(false)}
              className={`flex items-start gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-navy-950 hover:bg-royal-50 ${
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

function MobileTransactionCards({
  transactions,
  patchTransaction,
  reviewMode,
}: {
  transactions: AccountingTransaction[];
  patchTransaction: (transaction: AccountingTransaction, patch: AccountingTransactionPatch) => Promise<void>;
  reviewMode: boolean;
}) {
  if (!transactions.length) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center md:hidden">
        <FileSpreadsheet className="mx-auto h-7 w-7 text-royal-500" />
        <p className="mt-3 font-semibold text-navy-950">No transactions</p>
        <p className="mt-1 text-sm text-slate-500">Process a statement or adjust search.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 md:hidden">
      {transactions.map((transaction) => {
        const amount = transaction.creditAmount ?? transaction.debitAmount;
        const isCredit = Boolean(transaction.creditAmount);
        return (
          <article key={transaction.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-black text-slate-500">{transaction.transactionDate || "-"}</p>
                <p className="mt-1 line-clamp-2 text-sm font-black leading-5 text-navy-950">{transaction.description}</p>
              </div>
              <p className={`shrink-0 text-right text-sm font-black ${isCredit ? "text-emerald-700" : "text-rose-700"}`}>{money(amount ?? null)}</p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-slate-50 p-2">
                <p className="font-semibold text-slate-400">Category</p>
                <p className="mt-1 font-black text-navy-950">{transaction.accountCategory}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2">
                <p className="font-semibold text-slate-400">VAT</p>
                <p className="mt-1 font-black text-navy-950">{transaction.vatTreatment}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2">
                <p className="font-semibold text-slate-400">Confidence</p>
                <p className="mt-1 font-black text-navy-950">{Math.round(transaction.confidence)}%</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2">
                <p className="font-semibold text-slate-400">Review</p>
                <p className="mt-1 font-black text-navy-950">{transaction.reviewStatus === "approved" ? "Approved" : "Review"}</p>
              </div>
            </div>
            {reviewMode ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => void patchTransaction(transaction, { reviewStatus: "approved" })}
                  className="h-11 rounded-xl bg-emerald-50 text-xs font-black text-emerald-700"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void patchTransaction(transaction, { reviewStatus: "needs_review" })}
                  className="h-11 rounded-xl bg-rose-50 text-xs font-black text-rose-700"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => void patchTransaction(transaction, { notes: transaction.notes || "AI explanation requested." })}
                  className="h-11 rounded-xl bg-royal-50 text-xs font-black text-royal-700"
                >
                  AI Reason
                </button>
              </div>
            ) : (
              <details className="mt-3 rounded-lg bg-slate-50 p-3">
                <summary className="cursor-pointer text-xs font-black text-royal-700">View More</summary>
                <div className="mt-3 space-y-2">
                  <select
                    value={transaction.accountCategory}
                    onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base font-semibold"
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <select
                    value={transaction.vatTreatment}
                    onChange={(event) => void patchTransaction(transaction, { vatTreatment: event.target.value as VatTreatment })}
                    className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base font-semibold"
                  >
                    {vatTreatments.map((treatment) => (
                      <option key={treatment.value} value={treatment.value}>
                        {treatment.label}
                      </option>
                    ))}
                  </select>
                </div>
              </details>
            )}
          </article>
        );
      })}
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
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${wide ? "md:col-span-2 xl:col-span-1" : ""}`}>
      <div className="flex items-center gap-4">
        {icon ? <div className="rounded-lg bg-royal-50 p-3 text-royal-600">{icon}</div> : null}
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-500">{label}</p>
          <p className={`mt-2 truncate text-lg font-semibold ${danger ? "text-rose-700" : success ? "text-emerald-700" : warning ? "text-amber-700" : "text-navy-950"}`}>
            {value}
          </p>
          {subvalue ? <p className="mt-1 text-xs font-semibold text-slate-500">{subvalue}</p> : null}
        </div>
        {warning ? <AlertTriangle className="ml-auto h-5 w-5 text-amber-500" /> : null}
      </div>
    </div>
  );
}

function StatementRuns({
  runs,
  selectedRunId,
  selectedRunIds,
  search,
  sortBy,
  onToggleSelected,
  onSearchChange,
  onSortChange,
  onReprocess,
  onRefresh,
  onSelect,
}: {
  runs: AccountingStatementRun[];
  selectedRunId: string;
  selectedRunIds: string[];
  search: string;
  sortBy: string;
  onToggleSelected: (runId: string) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onReprocess: (runId: string) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(20);
  const filteredRuns = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    let next = runs;

    if (normalizedSearch) {
      next = next.filter((run) => {
        const haystack = [
          runDisplayTitle(run),
          run.companyName,
          run.accountNumber,
          statusLabel(run.status),
          fileNameFromPath(run.sourceStoragePath),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      });
    }

    const sorted = [...next];
    sorted.sort((a, b) => {
      if (sortBy === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sortBy === "month") {
        const keyA = `${new Date(a.createdAt).getFullYear()}-${new Date(a.createdAt).getMonth()}`;
        const keyB = `${new Date(b.createdAt).getFullYear()}-${new Date(b.createdAt).getMonth()}`;
        return keyB.localeCompare(keyA);
      }
      if (sortBy === "status") return statusLabel(a.status).localeCompare(statusLabel(b.status));
      if (sortBy === "company") return (a.companyName || "").localeCompare(b.companyName || "");
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return sorted;
  }, [runs, search, sortBy]);
  const visibleRuns = useMemo(() => filteredRuns.slice(0, visibleCount), [filteredRuns, visibleCount]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-navy-950">Statement runs</h2>
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
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search statements"
            className="min-h-11 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-medium outline-none focus:border-royal-300"
          />
        </label>
        <select
          value={sortBy}
          onChange={(event) => onSortChange(event.target.value)}
          className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="month">Month</option>
          <option value="company">Company</option>
          <option value="status">Status</option>
        </select>
      </div>
      <div className="space-y-3">
        {visibleRuns.length ? (
          visibleRuns.map((run) => (
            <div
              key={run.id}
              onClick={() => onSelect(run.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(run.id);
                }
              }}
              role="button"
              tabIndex={0}
              className={`w-full rounded-lg border p-3 text-left transition ${
                selectedRunId === run.id ? "border-royal-300 bg-royal-50 ring-4 ring-royal-50" : "border-slate-200 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selectedRunIds.includes(run.id)}
                  disabled={!["completed", "review"].includes(run.status)}
                  onChange={(event) => {
                    event.stopPropagation();
                    onToggleSelected(run.id);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="mt-2 h-5 w-5 rounded border-slate-300 text-royal-600 disabled:opacity-30"
                  aria-label={`Select ${runDisplayTitle(run)} for combined workbook`}
                />
                <div className="rounded-lg bg-rose-50 p-2 text-rose-600">
                  <FileText className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-navy-950">{runDisplayTitle(run)}</p>
                    <MoreVertical className="h-4 w-4 shrink-0 text-slate-400" />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{run.companyName || "Unknown company"}</p>
                  <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className="text-xs font-semibold text-slate-500">{compactDateTime(run.createdAt)}</p>
                    <p className="text-right text-xs font-semibold text-slate-500">
                      Confidence
                      <span className="ml-1 text-base font-semibold text-slate-700">{Math.round(run.confidence)}%</span>
                    </p>
                  </div>
                  <div className="mt-3 grid grid-cols-5 gap-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(run.id);
                      }}
                      className="min-h-11 rounded-lg bg-white text-[11px] font-semibold text-slate-600"
                    >
                      More
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onReprocess(run.id);
                      }}
                      className="min-h-11 rounded-lg bg-white text-[11px] font-semibold text-slate-600"
                    >
                      Reprocess
                    </button>
                    <button type="button" disabled className="min-h-11 rounded-lg bg-white text-[11px] font-semibold text-slate-400">Export</button>
                    <button type="button" disabled className="min-h-11 rounded-lg bg-white text-[11px] font-semibold text-slate-400">PDF</button>
                    <button type="button" disabled className="min-h-11 rounded-lg bg-white text-[11px] font-semibold text-slate-400">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm font-semibold text-slate-500">
            No FNB statements uploaded yet.
          </div>
        )}
        {filteredRuns.length > visibleRuns.length ? (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + 20)}
            className="min-h-11 w-full rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700"
          >
            Load more statements
          </button>
        ) : null}
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
  const [mobileOffsets, setMobileOffsets] = useState<Record<string, number>>({});
  const [dismissedTransactionIds, setDismissedTransactionIds] = useState<Record<string, true>>({});
  const touchStartRef = useRef<Record<string, { x: number; y: number }>>({});

  const mobileTransactions = transactions.filter((transaction) => !dismissedTransactionIds[transaction.id]);

  if (!transactions.length) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
        <FileSpreadsheet className="mx-auto h-8 w-8 text-royal-500" />
        <p className="mt-3 font-semibold text-navy-950">No transactions in this view</p>
        <p className="mt-1 text-sm text-slate-500">Process a statement or adjust the search filter.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {mobileTransactions.map((transaction) => (
          <article
            key={transaction.id}
            className="relative overflow-hidden rounded-lg border border-slate-200 bg-white"
            onTouchStart={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("button,select,input,textarea,a,label")) {
                delete touchStartRef.current[transaction.id];
                return;
              }

              const touch = event.touches[0];
              touchStartRef.current[transaction.id] = { x: touch.clientX, y: touch.clientY };
            }}
            onTouchMove={(event) => {
              const start = touchStartRef.current[transaction.id];
              if (!start) return;

              const touch = event.touches[0];
              const deltaX = touch.clientX - start.x;
              const deltaY = touch.clientY - start.y;
              if (Math.abs(deltaX) <= Math.abs(deltaY)) return;

              setMobileOffsets((current) => ({ ...current, [transaction.id]: Math.max(-120, Math.min(120, deltaX)) }));
            }}
            onTouchEnd={() => {
              const offset = mobileOffsets[transaction.id] ?? 0;
              delete touchStartRef.current[transaction.id];

              if (offset >= 80) {
                void patchTransaction(transaction, { reviewStatus: "approved" });
              }
              if (offset <= -80) {
                setDismissedTransactionIds((current) => ({ ...current, [transaction.id]: true }));
              }

              setMobileOffsets((current) => ({ ...current, [transaction.id]: 0 }));
            }}
          >
            <div className="pointer-events-none absolute inset-y-0 left-0 flex w-24 items-center justify-center bg-emerald-50 text-xs font-semibold text-emerald-700">
              Approve
            </div>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-rose-50 text-xs font-semibold text-rose-700">
              Dismiss
            </div>

            <div
              className="rounded-lg bg-white p-3 transition-transform duration-150"
              style={{ transform: `translateX(${mobileOffsets[transaction.id] ?? 0}px)` }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">{transaction.transactionDate || "-"}</p>
                  <p className="mt-1 text-sm font-semibold text-navy-950">{transaction.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void patchTransaction(transaction, {
                      reviewStatus: transaction.reviewStatus === "approved" ? "needs_review" : "approved",
                    })
                  }
                  className={`min-h-11 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    transaction.reviewStatus === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {transaction.reviewStatus === "approved" ? "Approved" : "Review"}
                </button>
              </div>

              <p className="mt-2 text-[11px] font-semibold text-slate-400">Swipe right to approve / Swipe left to dismiss</p>

              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <p className="text-slate-500">Amount</p>
                <p className="text-right font-semibold text-navy-950">{money((transaction.creditAmount ?? 0) - (transaction.debitAmount ?? 0))}</p>
                <p className="text-slate-500">Category</p>
                <p className="text-right font-semibold text-navy-950">{transaction.accountCategory}</p>
                <p className="text-slate-500">VAT</p>
                <p className="text-right font-semibold text-navy-950">{vatTreatments.find((v) => v.value === transaction.vatTreatment)?.label ?? transaction.vatTreatment}</p>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <select
                  value={transaction.accountCategory}
                  onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                  className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-navy-950 outline-none"
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <select
                  value={transaction.vatTreatment}
                  onChange={(event) => void patchTransaction(transaction, { vatTreatment: event.target.value as VatTreatment })}
                  className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-navy-950 outline-none"
                >
                  {vatTreatments.map((treatment) => (
                    <option key={treatment.value} value={treatment.value}>
                      {treatment.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </article>
        ))}
        {!mobileTransactions.length ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center text-sm font-semibold text-slate-500">
            All mobile cards were dismissed in this view.
          </div>
        ) : null}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
        <table className="w-full min-w-[1220px] text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
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
                <p className="font-semibold leading-5 text-navy-950">{transaction.description}</p>
                <p className="mt-1 text-xs font-bold text-slate-400">Confidence {Math.round(transaction.confidence)}%</p>
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-semibold text-emerald-700">{money(transaction.creditAmount)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-semibold text-rose-700">{money(transaction.debitAmount)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-bold text-navy-950">{money(transaction.runningBalance)}</td>
              <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-600">{transaction.bankCharge ? money(transaction.debitAmount) : "-"}</td>
              <td className="px-4 py-3">
                <select
                  value={transaction.accountCategory}
                  onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                  className="w-48 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
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
                  className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
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
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
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
    </>
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
    <div className="rounded-lg border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h3 className="font-semibold text-navy-950">{title}</h3>
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-2 px-4 py-3 sm:grid-cols-[260px_1fr]">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="text-sm font-semibold text-navy-950">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimpleTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-navy-950">{title}</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
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
              <tr key={`${row[0]}-${index}`} className={index === rows.length - 1 && row[0] === "Totals" ? "bg-slate-50 font-semibold" : ""}>
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
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-10 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-royal-50 text-royal-600">
          <Banknote className="h-7 w-7" />
        </div>
        <p className="mt-4 text-lg font-semibold text-navy-950">Select or upload an FNB statement</p>
        <p className="mx-auto mt-2 max-w-md text-sm font-medium text-slate-500">The accounting workspace appears once a statement run exists.</p>
      </div>
    </div>
  );
}

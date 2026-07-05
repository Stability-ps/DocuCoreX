"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  AlertTriangle,
  AlertCircle,
  BadgeCheck,
  Banknote,
  BarChart3,
  ChevronDown,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileSpreadsheet,
  FileText,
  Filter,
  Info,
  Loader2,
  MoreVertical,
  PackageCheck,
  PencilLine,
  RefreshCcw,
  Scale,
  Search,
  Shield,
  Trash2,
  TrendingDown,
  TrendingUp,
  UploadCloud,
  X,
} from "lucide-react";
import type {
  AccountingRunDetail,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
  VatTreatment,
} from "@/lib/accounting/types";
import {
  computeProfitLoss,
  computeCashFlow,
  computeFinancialRatios,
  detectVatAnomalies,
  detectDuplicates,
  detectUnusualTransactions,
  detectDirectorTransactions,
  computeSarsRisk,
  computeForecast,
  buildAuditSummary,
} from "@/lib/accounting/analytics";
import type {
  ProfitLossData,
  CashFlowData,
  FinancialRatios,
  VatAnomaly,
  DuplicateGroup,
  UnusualTransaction,
  DirectorTransaction,
  SarsRiskScore,
  ForecastData,
  AuditSummary,
} from "@/lib/accounting/analytics";
import type { AiCommentaryResult, AiCommentaryType } from "@/lib/accounting/ai-service";

type AccountingTab = "transactions" | "review" | "difference" | "summary" | "bank-rec" | "vat" | "general-ledger" | "trial-balance";
type AccountingModule = "bank-statements" | "financial-statements" | "tax-vat" | "ai-intelligence" | "forecasting" | "audit-tools";
type UploadQueueStatus = "Queued" | "Uploading" | "Uploaded" | "Processing" | "Completed" | "Review Required" | "Failed";
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
  { id: "review", label: "Review" },
  { id: "difference", label: "Difference Inspector" },
  { id: "summary", label: "Summary" },
  { id: "bank-rec", label: "Bank Reconciliation" },
  { id: "vat", label: "VAT" },
  { id: "general-ledger", label: "General Ledger" },
  { id: "trial-balance", label: "Trial Balance" },
];

const accountingModules: Array<{
  id: AccountingModule;
  label: string;
  status: "live" | "in-development" | "planned";
}> = [
  { id: "bank-statements", label: "Bank Statements", status: "live" },
  { id: "financial-statements", label: "Financial Statements", status: "live" },
  { id: "tax-vat", label: "Tax & VAT", status: "live" },
  { id: "ai-intelligence", label: "Transaction Insights", status: "live" },
  { id: "forecasting", label: "Forecasting", status: "live" },
  { id: "audit-tools", label: "Audit Tools", status: "live" },
];

const supportedBanks = [
  { name: "FNB", active: true },
  { name: "ABSA", active: false },
  { name: "Nedbank", active: false },
  { name: "Standard Bank", active: false },
  { name: "Capitec", active: false },
  { name: "Investec", active: false },
];

const canShowTechnicalDetails =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ACCOUNTING_DIAGNOSTICS === "true";

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
    review: "Review Required",
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

function canProcessRunStatus(status: AccountingStatementRun["status"]) {
  return status !== "processing";
}

function processLabelForRunStatus(status: AccountingStatementRun["status"]) {
  if (status === "queued") return "Process";
  if (status === "processing") return "Processing...";
  if (status === "completed") return "Process Again";
  if (status === "failed") return "Retry";
  return "Process";
}

function queueStatusFromRunStatus(status: AccountingStatementRun["status"]): UploadQueueStatus {
  if (status === "queued") return "Queued";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Completed";
  if (status === "review") return "Review Required";
  if (status === "failed" || status === "cancelled") return "Failed";
  return "Queued";
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
    return "Review required. We extracted a draft workbook, but this statement needs review before final export. Some transactions or bank charges may need correction.";
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

type ReviewDiagnostics = {
  openingBalance: number | null;
  closingBalance: number | null;
  calculatedClosing: number | null;
  difference: number | null;
  credits: number | null;
  debits: number | null;
  parserVersion: string | null;
  validationTime: string | null;
  confidence: number | null;
  detectedLayout: string | null;
  balanceGap: number | null;
  rawMessage: string;
};

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^\d.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function findJsonPayload(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying less precise payloads.
    }
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseReviewDiagnostics(run: AccountingStatementRun | null, totals?: { debit: number; credit: number }) {
  const rawMessage = run?.error ?? "";
  const parsed = findJsonPayload(rawMessage);
  const root = objectRecord(parsed);
  const detail = objectRecord(root.detail);
  const summary = objectRecord(root.summary ?? detail.summary);
  const worker = objectRecord(root.worker ?? detail.worker);
  const openingBalance = parseAmount(summary.opening_balance) ?? run?.openingBalance ?? null;
  const closingBalance = parseAmount(summary.closing_balance) ?? run?.closingBalance ?? null;
  const calculatedClosing =
    parseAmount(summary.calculated_closing) ??
    (openingBalance !== null && totals ? openingBalance + totals.credit - totals.debit : null);
  const difference =
    closingBalance !== null && calculatedClosing !== null
      ? Math.abs(calculatedClosing - closingBalance)
      : null;

  const errors = Array.isArray(root.errors ?? detail.errors) ? ((root.errors ?? detail.errors) as unknown[]).map(String) : [];
  const gapMatch = rawMessage.match(/(?:gap|difference|missing)[^\d-]*(-?\d[\d,]*(?:\.\d+)?)/i);

  return {
    openingBalance,
    closingBalance,
    calculatedClosing,
    difference,
    credits: parseAmount(summary.total_credits),
    debits: parseAmount(summary.total_debits),
    parserVersion: typeof worker.parser_version === "string" ? worker.parser_version : run?.parserVersion ?? null,
    validationTime: run?.updatedAt ?? null,
    confidence: run?.confidence ?? null,
    detectedLayout: run?.parserProfile ?? "FNB statement layout",
    balanceGap: parseAmount(gapMatch?.[1]) ?? difference,
    rawMessage: errors.length ? errors.join("\n") : rawMessage,
  } satisfies ReviewDiagnostics;
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
  const [showExportModal, setShowExportModal] = useState(false);
  const [detail, setDetail] = useState<AccountingRunDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [activeTab, setActiveTab] = useState<AccountingTab>("transactions");
  const [query, setQuery] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [runSort, setRunSort] = useState("newest");
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideType, setOverrideType] = useState<CombineOverrideType>("account");
  const [overrideText, setOverrideText] = useState("");
  const [uploadCollapsed, setUploadCollapsed] = useState(false);
  const [activeModule, setActiveModule] = useState<AccountingModule>("bank-statements");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const processableRunIds = useMemo(() => runs.filter((run) => canProcessRunStatus(run.status)).map((run) => run.id), [runs]);
  const selectedProcessableRunIds = useMemo(
    () => selectedRunIds.filter((runId) => canProcessRunStatus(runById.get(runId)?.status ?? "queued")),
    [runById, selectedRunIds],
  );
  const selectedRunLabel = `${selectedRunIds.length} ${selectedRunIds.length === 1 ? "Statement" : "Statements"} Selected`;
  const contextualProcessLabel = useMemo(() => {
    if (busy === "bulk-process") return "Processing...";
    if (!selectedRunIds.length) return "Process";
    if (selectedRunIds.length === 1) {
      const status = runById.get(selectedRunIds[0])?.status ?? "queued";
      return processLabelForRunStatus(status);
    }

    const statuses = selectedRunIds.map((runId) => runById.get(runId)?.status ?? "queued");
    if (statuses.every((status) => status === "completed")) return "Process Again";
    if (statuses.every((status) => status === "failed")) return "Retry";
    return "Process";
  }, [busy, runById, selectedRunIds]);
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

  useEffect(() => {
    if (!runs.length) return;
    setUploadQueue((queue) =>
      queue.map((item) => {
        if (!item.runId) return item;
        const run = runById.get(item.runId);
        if (!run) return item;
        const nextStatus = queueStatusFromRunStatus(run.status);
        if (nextStatus === item.status) return item;
        return { ...item, status: nextStatus, error: nextStatus === "Failed" ? run.error ?? item.error : item.error };
      }),
    );
  }, [runById, runs.length]);

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
      setUploadCollapsed(true);
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

  async function deleteRuns(runIds: string[]) {
    const ids = Array.from(new Set(runIds)).filter(Boolean);
    if (!ids.length) return;
    const previousRuns = runs;
    const previousDetail = detail;
    const nextSelectedId = runs.find((run) => !ids.includes(run.id))?.id ?? "";

    setBusy("delete");
    setError("");
    setMessage("");
    setRuns((current) => current.filter((run) => !ids.includes(run.id)));
    setSelectedRunIds((current) => current.filter((id) => !ids.includes(id)));
    if (ids.includes(selectedRunId)) {
      setSelectedRunId(nextSelectedId);
      setDetail(null);
    }

    try {
      const response =
        ids.length === 1
          ? await fetch(`/api/accounting/fnb/runs/${ids[0]}`, { method: "DELETE" })
          : await fetch("/api/accounting/fnb/runs/bulk", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ runIds: ids }),
            });
      const data = (await response.json().catch(() => ({}))) as { deletedIds?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not delete selected statements.");
      setMessage(ids.length === 1 ? "Statement deleted." : `${ids.length} statements deleted.`);
      await loadRuns(nextSelectedId).catch(() => undefined);
    } catch (deleteError) {
      setRuns(previousRuns);
      setDetail(previousDetail);
      setSelectedRunIds(runIds);
      if (previousDetail) setSelectedRunId(previousDetail.run.id);
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete selected statements.");
    } finally {
      setBusy("");
      setDeleteDialogOpen(false);
      setDeleteTargetIds([]);
    }
  }

  function requestDelete(runIds: string[]) {
    setDeleteTargetIds(Array.from(new Set(runIds)).filter(Boolean));
    setDeleteDialogOpen(true);
  }

  async function processAllRuns() {
    if (!processableRunIds.length) return;
    setBusy("bulk-process");
    setError("");
    setMessage("");
    try {
      for (const runId of processableRunIds) {
        await processRun(runId, { manageBusy: false, refreshAfter: false });
      }
      await loadRuns(processableRunIds[0]).catch(() => undefined);
      setMessage(`${processableRunIds.length} statements queued for processing.`);
    } finally {
      setBusy("");
    }
  }

  async function processSelectedRuns() {
    if (!selectedProcessableRunIds.length) return;
    setBusy("bulk-process");
    setError("");
    setMessage("");
    try {
      for (const runId of selectedProcessableRunIds) {
        await processRun(runId, { manageBusy: false, refreshAfter: false });
      }
      await loadRuns(selectedProcessableRunIds[0]).catch(() => undefined);
      setMessage(`${selectedProcessableRunIds.length} selected statements queued for processing.`);
    } finally {
      setBusy("");
    }
  }

  async function processRun(runId: string, options?: { manageBusy?: boolean; refreshAfter?: boolean }) {
    const manageBusy = options?.manageBusy ?? true;
    const refreshAfter = options?.refreshAfter ?? true;

    if (manageBusy) setBusy(`process:${runId}`);
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
        setMessage(data.result.review_issue?.message ?? "Statement processed. Manual review is required before export.");
      } else {
        setMessage("Statement processed successfully. You can now review and export.");
      }
      if (refreshAfter) await loadRuns(runId);
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : "Processing failed.");
      if (refreshAfter) await loadRuns(runId).catch(() => undefined);
    } finally {
      if (manageBusy) setBusy("");
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
  const reviewDiagnostics = useMemo(() => parseReviewDiagnostics(detail?.run ?? null, totals), [detail?.run, totals]);
  const estimatedAffectedRows = Math.max(
    1,
    Math.min(
      transactions.length || 1,
      Math.max(reviewItems.length, reviewDiagnostics.difference && reviewDiagnostics.difference > 0.01 ? 3 : 0),
    ),
  );
  const affectedTransactions = useMemo(() => {
    const explicitReviewRows = reviewItems.slice(0, estimatedAffectedRows);
    if (explicitReviewRows.length) return explicitReviewRows;
    if (!transactions.length) return [];
    const lowConfidenceRows = transactions
      .filter((transaction) => transaction.confidence < 85 || transaction.bankCharge)
      .slice(0, estimatedAffectedRows);
    return lowConfidenceRows.length ? lowConfidenceRows : transactions.slice(0, estimatedAffectedRows);
  }, [estimatedAffectedRows, reviewItems, transactions]);
  const affectedTransactionIds = useMemo(() => new Set(affectedTransactions.map((transaction) => transaction.id)), [affectedTransactions]);

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

  const detailAnalytics = useMemo(() => {
    if (!detail) return null;
    const txns = detail.transactions;
    const run = detail.run;
    const vatAnomalies = detectVatAnomalies(txns);
    const duplicates = detectDuplicates(txns);
    const unusuals = detectUnusualTransactions(txns);
    const directors = detectDirectorTransactions(txns);
    const riskScore = computeSarsRisk(txns, vatAnomalies, duplicates, unusuals, directors);
    return {
      pl: computeProfitLoss(txns, run),
      cashFlow: computeCashFlow(txns, run),
      ratios: computeFinancialRatios(txns, run, totals),
      forecast: computeForecast(txns, run, totals),
      vatAnomalies,
      duplicates,
      unusuals,
      directors,
      riskScore,
      auditSummary: buildAuditSummary(txns, run, duplicates, unusuals, vatAnomalies, riskScore),
    };
  }, [detail, totals]);

  return (
    <div className={`space-y-4 p-4 sm:p-6 lg:space-y-5 lg:p-8 ${detail ? "pb-[calc(11rem+env(safe-area-inset-bottom))] md:pb-6 lg:pb-8" : ""}`}>
      <header className="flex flex-col gap-2 md:gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="hidden text-sm font-bold text-slate-500 md:block">Accounting Intelligence <span className="mx-2 text-slate-300">›</span> Bank Statements</p>
          <h1 className="text-2xl font-semibold tracking-tight text-navy-950 md:mt-2 sm:text-3xl md:hidden">Accounting</h1>
          <h1 className="mt-2 hidden text-2xl font-semibold tracking-tight text-navy-950 sm:text-3xl md:block">Bank statement processing</h1>
          <p className="mt-1 text-sm font-semibold text-slate-500 md:hidden">Upload, process, review, and export statements</p>
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

      {/* Module navigation */}
      <div className="-mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
        <div className="flex min-w-max gap-1 border-b border-slate-200 px-4 sm:px-6 lg:px-8">
          {accountingModules.map((mod) => (
            <button
              key={mod.id}
              type="button"
              onClick={() => setActiveModule(mod.id)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold transition ${
                activeModule === mod.id
                  ? "border-royal-600 text-royal-700"
                  : "border-transparent text-slate-500 hover:text-navy-950"
              }`}
            >
              {mod.label}
              {mod.status !== "live" ? (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black ${
                  mod.status === "in-development" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"
                }`}>
                  {mod.status === "in-development" ? "Dev" : "Soon"}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {activeModule === "financial-statements" ? (
        detailAnalytics ? (
          <FinancialStatementsPanel pl={detailAnalytics.pl} cashFlow={detailAnalytics.cashFlow} ratios={detailAnalytics.ratios} />
        ) : (
          <ModuleNoDataMessage label="Financial Statements" onSelect={() => setActiveModule("bank-statements")} />
        )
      ) : null}

      {activeModule === "tax-vat" ? (
        detailAnalytics ? (
          <TaxVatPanel vatRows={vatRows} vatAnomalies={detailAnalytics.vatAnomalies} riskScore={detailAnalytics.riskScore} />
        ) : (
          <ModuleNoDataMessage label="Tax & VAT" onSelect={() => setActiveModule("bank-statements")} />
        )
      ) : null}

      {activeModule === "ai-intelligence" ? (
        detailAnalytics ? (
          <AiTransactionPanel duplicates={detailAnalytics.duplicates} unusuals={detailAnalytics.unusuals} directors={detailAnalytics.directors} />
        ) : (
          <ModuleNoDataMessage label="Transaction Insights" onSelect={() => setActiveModule("bank-statements")} />
        )
      ) : null}

      {activeModule === "forecasting" ? (
        detailAnalytics && detail ? (
          <ForecastPanel forecast={detailAnalytics.forecast} ratios={detailAnalytics.ratios} run={detail.run} />
        ) : (
          <ModuleNoDataMessage label="Forecasting" onSelect={() => setActiveModule("bank-statements")} />
        )
      ) : null}

      {activeModule === "audit-tools" ? (
        detailAnalytics && detail ? (
          <AuditToolsPanel auditSummary={detailAnalytics.auditSummary} run={detail.run} transactions={transactions} />
        ) : (
          <ModuleNoDataMessage label="Audit Tools" onSelect={() => setActiveModule("bank-statements")} />
        )
      ) : null}

      {activeModule === "bank-statements" ? (
      <>
      <section
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void uploadFiles(Array.from(event.dataTransfer.files));
        }}
        className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4"
      >
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
        <div className="grid gap-3 xl:grid-cols-[1fr_auto] xl:items-center">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-navy-950">FNB bank statements</p>
              {uploadCollapsed ? (
                <button type="button" onClick={() => setUploadCollapsed(false)} className="text-xs font-black text-royal-700">
                  Show upload options
                </button>
              ) : null}
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-500">Upload, process, review, and export transactions.</p>
          </div>
          {!uploadCollapsed ? (
          <div className="grid gap-3 sm:grid-cols-[220px_auto] sm:items-end">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-500">Select Bank</span>
              <select
                value="FNB South Africa"
                disabled
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-navy-950"
              >
                <option>FNB South Africa</option>
              </select>
            </label>
            <div className="rounded-xl bg-royal-50 p-2 text-center">
              <button
                type="button"
                disabled={busy === "upload"}
                onClick={() => inputRef.current?.click()}
                className="inline-flex h-10 w-full min-w-40 items-center justify-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
              >
                {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Upload PDFs
              </button>
              <p className="mt-1 text-[11px] font-semibold text-slate-500">PDF up to 200MB</p>
            </div>
          </div>
          ) : (
            <button
              type="button"
              disabled={busy === "upload"}
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white shadow-sm disabled:bg-slate-300"
            >
              <UploadCloud className="h-4 w-4" />
              Upload Statement
            </button>
          )}
          {!uploadCollapsed ? (
          <div className="xl:col-span-2">
            <div className="flex flex-wrap gap-2">
              {supportedBanks.map((bank) => (
                <span
                  key={bank.name}
                  className={`rounded-full border px-2.5 py-1 text-center text-[11px] font-black ${
                    bank.active ? "border-royal-200 bg-royal-50 text-royal-700" : "border-slate-200 bg-slate-50 text-slate-400"
                  }`}
                  title={bank.active ? "Active" : "Coming Soon"}
                >
                  {bank.name}
                  {!bank.active ? <span className="pl-1 text-[10px] font-semibold">Soon</span> : null}
                </span>
              ))}
            </div>
          </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy === "upload"}
            onClick={() => inputRef.current?.click()}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-royal-600 px-3 text-xs font-black text-white shadow-sm disabled:bg-slate-300"
          >
            <UploadCloud className="h-4 w-4" />
            Upload Statements
          </button>
          <button
            type="button"
            disabled={!processableRunIds.length || busy === "bulk-process"}
            onClick={() => void processAllRuns()}
            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:text-slate-300"
          >
            {busy === "bulk-process" ? "Processing..." : "Process All"}
          </button>
          <button
            type="button"
            disabled={!selectedRunIds.length || !selectedProcessableRunIds.length || busy === "bulk-process"}
            onClick={() => void processSelectedRuns()}
            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:text-slate-300"
          >
            {busy === "bulk-process" ? "Processing..." : "Process Selected"}
          </button>
          <button
            type="button"
            disabled={!uploadQueue.some((item) => item.status === "Completed")}
            onClick={() => {
              setUploadQueue((queue) => queue.filter((item) => item.status !== "Completed"));
              setMessage("Completed queue items cleared.");
            }}
            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:text-slate-300"
          >
            Clear Completed
          </button>
        </div>
      </section>

      {selectedRunIds.length ? (
        <section className="sticky top-2 z-40 rounded-xl border border-royal-200 bg-royal-50/95 p-3 shadow-md backdrop-blur supports-[backdrop-filter]:bg-royal-50/80 md:p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm font-black text-navy-950">{selectedRunLabel}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void processSelectedRuns()}
                disabled={!selectedProcessableRunIds.length || busy === "bulk-process"}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:text-slate-300"
              >
                {contextualProcessLabel}
              </button>
              <button
                type="button"
                onClick={() => requestDelete(selectedRunIds)}
                disabled={busy === "delete"}
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-rose-200 bg-white px-3 text-xs font-black text-rose-700 disabled:text-slate-300"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setShowExportModal(true)}
                className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-royal-600 px-3 text-xs font-black text-white hover:bg-royal-700"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
                Export
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {uploadQueue.length ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-navy-950">Upload queue</h2>
              <p className="text-sm font-medium text-slate-500">Multiple statements can be uploaded and processed together.</p>
            </div>
            <button type="button" onClick={() => setUploadQueue([])} className="text-xs font-black text-slate-500" title="Remove all items from queue">
              Clear Queue
            </button>
          </div>
          <div className="w-full space-y-4">
            {uploadQueue.map((item) => (
              <div key={item.id} className="relative box-border h-auto w-full rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-navy-950" title={item.name}>
                      {item.name}
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">{fileSize(item.size)}</p>
                  </div>
                  <span
                    className={`max-w-full shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-black ${
                      item.status === "Failed"
                        ? "bg-rose-50 text-rose-700"
                        : item.status === "Uploaded" || item.status === "Completed"
                          ? "bg-emerald-50 text-emerald-700"
                          : item.status === "Review Required"
                            ? "bg-amber-50 text-amber-700"
                          : "bg-blue-50 text-blue-700"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                {item.status === "Uploading" || item.status === "Processing" ? (
                  <div className="mt-3 h-2 w-full max-w-full overflow-hidden rounded-full bg-blue-100">
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-royal-500" />
                  </div>
                ) : null}
                {item.status === "Uploaded" ? <p className="mt-2 break-words text-xs font-semibold text-slate-600">Uploaded and ready to process.</p> : null}
                {item.status === "Completed" ? <p className="mt-2 break-words text-xs font-semibold text-emerald-700">Completed. Ready for export.</p> : null}
                {item.status === "Review Required" ? <p className="mt-2 break-words text-xs font-semibold text-amber-700">Review required before final export.</p> : null}
                {item.error ? <p className="mt-2 break-words text-xs font-semibold text-rose-700">{item.error}</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.runId ? (
                    <Link
                      href={`/accounting/statements/${item.runId}`}
                      className="inline-flex min-h-10 items-center rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 shadow-sm ring-1 ring-slate-200 hover:bg-royal-50"
                    >
                      Open Statement
                    </Link>
                  ) : null}
                  {item.status === "Failed" && item.file ? (
                    <button
                      type="button"
                      onClick={() => void retryUpload(item)}
                      className="min-h-10 rounded-lg bg-white px-3 py-2 text-xs font-black text-royal-700 shadow-sm ring-1 ring-slate-200"
                    >
                      Retry Upload
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setUploadQueue((queue) => queue.filter((queuedItem) => queuedItem.id !== item.id))}
                    className="min-h-10 rounded-lg bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm ring-1 ring-slate-200"
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
          {diagnostics && canShowTechnicalDetails ? (
            <details className="mt-3 rounded-xl border border-rose-200 bg-white/70 p-3 text-xs font-semibold text-rose-900">
              <summary className="cursor-pointer">Show technical details</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{diagnostics}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <CompactSummaryBar
        run={detail?.run ?? null}
        debit={transactions.length ? totals.debit : null}
        credit={transactions.length ? totals.credit : null}
        reviewCount={totals.review}
      />

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <StatementRuns
          runs={runs}
          selectedRunId={selectedRunId}
          selectedRunIds={selectedRunIds}
          search={runSearch}
          sortBy={runSort}
          onToggleSelected={(runId) =>
            setSelectedRunIds((current) => (current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]))
          }
          onSetSelected={setSelectedRunIds}
          onSearchChange={setRunSearch}
          onSortChange={setRunSort}
          onRefresh={() => void loadRuns().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Refresh failed."))}
          onSelect={(runId) => {
            setSelectedRunId(runId);
            setActiveTab("transactions");
            void loadRunDetail(runId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to open statement."));
          }}
        />

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
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
                <div className="hidden md:block" />
              </div>

              {detail.run.status === "review" && detail.run.error ? (
                <ReviewRequiredPanel
                  run={detail.run}
                  diagnostics={reviewDiagnostics}
                  affectedRows={affectedTransactions.length}
                  onReview={() => {
                    setActiveTab("review");
                    window.requestAnimationFrame(() => {
                      const firstAffected = affectedTransactions[0];
                      document.getElementById(firstAffected ? `transaction-${firstAffected.id}` : "accounting-review-table")?.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                    });
                  }}
                  onViewDifference={() => setActiveTab("difference")}
                  onRegenerate={() => void processRun(detail.run.id)}
                  busy={busy === `process:${detail.run.id}`}
                />
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
                  <div id="accounting-review-table">
                    <TransactionTable
                      transactions={filteredRows}
                      patchTransaction={patchTransaction}
                      affectedTransactionIds={affectedTransactionIds}
                      emptyLabel={activeTab === "review" ? "All items reviewed" : undefined}
                      emptyDescription={activeTab === "review" ? "No transactions are pending review for this statement." : undefined}
                      emptyVariant={activeTab === "review" ? "success" : "default"}
                    />
                  </div>
                </>
              ) : null}

              {activeTab === "difference" ? (
                <DifferenceInspector
                  run={detail.run}
                  diagnostics={reviewDiagnostics}
                  affectedTransactions={affectedTransactions}
                  totals={totals}
                  expectedClosing={expectedClosing}
                  difference={recDifference}
                  onReviewTransactions={() => setActiveTab("review")}
                  onAcceptSuggestion={() => {
                    const firstAffected = affectedTransactions[0];
                    if (firstAffected) void patchTransaction(firstAffected, { reviewStatus: "approved", notes: firstAffected.notes || "Reviewed from Difference Inspector." });
                  }}
                />
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
      </>
      ) : null}
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
      {deleteDialogOpen ? (
        <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/40 p-3 sm:items-center sm:justify-center">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-navy-950">Delete {deleteTargetIds.length === 1 ? "statement" : "statements"}?</h3>
            <p className="mt-2 text-sm font-medium leading-6 text-slate-600">
              This removes the selected statement{deleteTargetIds.length === 1 ? "" : "s"} from this workspace and moves related documents to Trash.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setDeleteTargetIds([]);
                }}
                className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy === "delete"}
                onClick={() => void deleteRuns(deleteTargetIds)}
                className="min-h-11 flex-1 rounded-xl bg-rose-600 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy === "delete" ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showExportModal && selectedRunIds.length ? (
        <ExportOptionsModal
          runIds={selectedRunIds}
          combinedLabel="Combined Full Pack"
          onClose={() => setShowExportModal(false)}
          onCombined={() => void createCombinedWorkbookWithPrecheck()}
        />
      ) : null}

    </div>
  );
}

type ExportOption = { label: string; section: string; detail: string };

// Every real export the pack can produce. Each downloads individually as a
// styled single-sheet workbook; the full pack bundles the core sheets. Kept in
// sync with the export engine's EXPORT_MENU.
const EXPORT_OPTIONS: ExportOption[] = [
  { label: "Transactions", section: "transactions", detail: "Full transaction listing" },
  { label: "Executive Summary", section: "summary", detail: "Dashboard of the statement" },
  { label: "VAT Working Paper", section: "vat", detail: "VAT per line + VAT201 boxes" },
  { label: "General Ledger", section: "general-ledger", detail: "Running-balance ledger" },
  { label: "Trial Balance", section: "trial-balance", detail: "Debit and credit balances" },
  { label: "Profit & Loss", section: "profit-loss", detail: "Recognised revenue and expenses" },
  { label: "Balance Sheet", section: "balance-sheet", detail: "Cash and confirmed balances" },
  { label: "Cash Flow", section: "cash-flow", detail: "Cash movements by activity" },
  { label: "Bank Reconciliation", section: "bank-reconciliation", detail: "Opening → closing balance check" },
  { label: "Review Queue", section: "review-queue", detail: "Items requiring attention" },
];
const FULL_PACK_OPTION: ExportOption = {
  label: "Full Accounting Pack",
  section: "all",
  detail: "Every core sheet in one Excel workbook",
};

function exportHref(runId: string, section: string) {
  return `/api/accounting/fnb/export/${runId}?section=${section}`;
}

function ExportDropdown({
  run,
  reviewCount,
  open,
  onOpenChange,
  mobile = false,
  disabled = false,
}: {
  run: AccountingStatementRun;
  reviewCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mobile?: boolean;
  disabled?: boolean;
}) {
  const isDraftExport = run.status === "review";
  const buttonLabel = isDraftExport ? "Export draft" : "Export";
  void reviewCount;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className={`${mobile ? "h-11 w-full justify-center rounded-xl" : "h-11 rounded-lg px-4"} inline-flex items-center gap-2 bg-royal-600 text-sm font-semibold text-white hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ArrowDownToLine className="h-4 w-4" />
        {buttonLabel}
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div className={`${mobile ? "fixed inset-x-3 bottom-[calc(9.5rem+env(safe-area-inset-bottom))]" : "absolute right-0 mt-2 w-80"} z-50 max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl`} role="menu">
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Export options</p>
          {[...EXPORT_OPTIONS, FULL_PACK_OPTION].map((option, index) => (
            <a
              key={option.section}
              href={exportHref(run.id, option.section)}
              onClick={() => onOpenChange(false)}
              className={`flex items-start gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-navy-950 hover:bg-royal-50 ${
                index === EXPORT_OPTIONS.length ? "mt-2 border-t border-slate-100 pt-4" : ""
              }`}
              role="menuitem"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <span>
                {option.section === "all" && isDraftExport ? "Full draft pack" : option.label}
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                  {option.detail}
                </span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Export selector for the top action bar. Operates on the selected statement(s):
// single selection offers every per-section download; multiple selection offers a
// combined full pack plus per-section downloads for the first selected statement.
function ExportOptionsModal({
  runIds,
  combinedLabel,
  onClose,
  onCombined,
}: {
  runIds: string[];
  combinedLabel: string;
  onClose: () => void;
  onCombined: () => void;
}) {
  const primaryRunId = runIds[0];
  const multiple = runIds.length > 1;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-navy-950/40 p-4 sm:items-center" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-navy-950">Export</h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {multiple ? `${runIds.length} statements selected` : "Choose what to download"}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400">
            <X className="h-5 w-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (multiple) {
              onCombined();
            } else {
              window.location.href = exportHref(primaryRunId, "all");
            }
            onClose();
          }}
          className="mt-4 flex w-full items-center justify-between gap-3 rounded-xl border border-royal-200 bg-royal-50 px-4 py-3 text-left hover:bg-royal-100"
        >
          <span>
            <span className="block text-sm font-bold text-royal-800">{multiple ? combinedLabel : "Full Accounting Pack"}</span>
            <span className="mt-0.5 block text-xs font-semibold text-royal-600">Every section in one Excel workbook · XLSX</span>
          </span>
          <ArrowDownToLine className="h-5 w-5 shrink-0 text-royal-600" />
        </button>

        <p className="mt-4 px-1 text-[11px] font-black uppercase tracking-wide text-slate-400">
          {multiple ? "Individual sections (first selected statement)" : "Individual sections"}
        </p>
        <div className="mt-2 space-y-1.5">
          {EXPORT_OPTIONS.map((option) => (
            <a
              key={option.section}
              href={exportHref(primaryRunId, option.section)}
              onClick={onClose}
              className="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-navy-950 hover:border-royal-200 hover:bg-royal-50"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
              <span className="min-w-0">
                {option.label}
                <span className="mt-0.5 block truncate text-xs font-semibold text-slate-500">
                  {option.detail}
                </span>
              </span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewRequiredPanel({
  run,
  diagnostics,
  affectedRows,
  onReview,
  onViewDifference,
  onRegenerate,
  busy,
}: {
  run: AccountingStatementRun;
  diagnostics: ReviewDiagnostics;
  affectedRows: number;
  onReview: () => void;
  onViewDifference: () => void;
  onRegenerate: () => void;
  busy: boolean;
}) {
  const confidence = diagnostics.confidence ?? run.confidence;
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-amber-700 shadow-sm ring-1 ring-amber-200">
            <AlertTriangle className="h-4 w-4" />
            Review required
          </div>
          <h3 className="mt-3 text-xl font-semibold text-navy-950">Review required</h3>
          <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
            We extracted a draft workbook, but this statement needs review before final export. Some transactions or bank charges may need correction.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[420px]">
          {[
            ["Transactions extracted", "Complete", true],
            ["Workbook generated", run.workbookStoragePath ? "Ready" : "Draft ready", true],
            ["Reconciliation needs review", "Needs attention", false],
          ].map(([label, value, ok]) => (
            <div key={label as string} className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-amber-100">
              <div className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              </div>
              <p className="mt-2 text-xs font-black uppercase tracking-[0.08em] text-slate-400">{label}</p>
              <p className="mt-1 text-sm font-black text-navy-950">{value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <ReviewMetric label="Difference detected" value={money(diagnostics.difference)} tone="text-amber-700" />
        <ReviewMetric label="Confidence" value={`${Math.round(confidence)}%`} tone={confidence < 70 ? "text-amber-700" : "text-navy-950"} />
        <ReviewMetric label="Estimated affected rows" value={plainNumber(affectedRows)} tone="text-navy-950" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onReview} className="min-h-10 rounded-lg bg-royal-600 px-4 text-sm font-black text-white shadow-sm">
          Review Transactions
        </button>
        <button type="button" onClick={onViewDifference} className="min-h-10 rounded-lg border border-amber-200 bg-white px-4 text-sm font-black text-amber-800">
          View Difference
        </button>
        <button type="button" onClick={onRegenerate} disabled={busy} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 disabled:text-slate-300">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          Regenerate Workbook
        </button>
      </div>

      {canShowTechnicalDetails ? <TechnicalDetails diagnostics={diagnostics} /> : null}
    </section>
  );
}

function ReviewMetric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-amber-100">
      <p className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-black ${tone}`}>{value}</p>
    </div>
  );
}

function TechnicalDetails({ diagnostics }: { diagnostics: ReviewDiagnostics }) {
  const rows: Array<[string, string]> = [
    ["Opening Balance", money(diagnostics.openingBalance)],
    ["Closing Balance", money(diagnostics.closingBalance)],
    ["Calculated Closing", money(diagnostics.calculatedClosing)],
    ["Difference", money(diagnostics.difference)],
    ["Credits", money(diagnostics.credits)],
    ["Debits", money(diagnostics.debits)],
    ["Parser Version", diagnostics.parserVersion ?? "-"],
    ["Validation Time", diagnostics.validationTime ? compactDateTime(diagnostics.validationTime) : "-"],
    ["Confidence", diagnostics.confidence !== null ? `${Math.round(diagnostics.confidence)}%` : "-"],
    ["Detected Layout", diagnostics.detectedLayout ?? "-"],
    ["Balance Gap", money(diagnostics.balanceGap)],
  ];

  return (
    <details className="mt-4 rounded-lg border border-amber-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-black text-navy-950">Technical Details</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">{label}</p>
            <p className="mt-1 break-words text-sm font-black text-navy-950">{value}</p>
          </div>
        ))}
      </div>
      {diagnostics.rawMessage ? (
        <div className="mt-3 rounded-lg bg-slate-950 p-3 text-xs font-semibold leading-5 text-slate-100">
          <p className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">Raw Validation Message</p>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words">{diagnostics.rawMessage}</pre>
        </div>
      ) : null}
    </details>
  );
}

function DifferenceInspector({
  run,
  diagnostics,
  affectedTransactions,
  totals,
  expectedClosing,
  difference,
  onReviewTransactions,
  onAcceptSuggestion,
}: {
  run: AccountingStatementRun;
  diagnostics: ReviewDiagnostics;
  affectedTransactions: AccountingTransaction[];
  totals: { debit: number; credit: number; bankCharges: number; review: number };
  expectedClosing: number;
  difference: number;
  onReviewTransactions: () => void;
  onAcceptSuggestion: () => void;
}) {
  const previous = affectedTransactions[0] ?? null;
  const current = affectedTransactions[1] ?? affectedTransactions[0] ?? null;
  const absDifference = Math.abs(difference);
  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-600">Difference Inspector</p>
            <h3 className="mt-1 text-xl font-semibold text-navy-950">Reconciliation needs review</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Review the suggested rows and update the statement until the difference reaches zero.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-black ${absDifference < 0.01 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {absDifference < 0.01 ? "Reconciled" : `Difference remaining: ${money(absDifference)}`}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <ReviewMetric label="Expected balance" value={money(expectedClosing)} tone="text-navy-950" />
          <ReviewMetric label="Actual balance" value={money(run.closingBalance)} tone="text-navy-950" />
          <ReviewMetric label="Difference" value={money(absDifference)} tone={absDifference < 0.01 ? "text-emerald-700" : "text-amber-700"} />
          <ReviewMetric label="Confidence" value={`${Math.round(diagnostics.confidence ?? run.confidence)}%`} tone="text-navy-950" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <TransactionSnapshot title="Previous transaction" transaction={previous} />
        <TransactionSnapshot title="Current transaction" transaction={current} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h4 className="text-sm font-black text-navy-950">Suggested fixes</h4>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {[
            ["Possible missing bank charge", diagnostics.balanceGap ?? absDifference, "A balance movement may not have appeared as a visible transaction."],
            ["Possible OCR amount issue", absDifference, "One amount may need correction if the PDF text was unclear."],
            ["Possible missing transaction", absDifference, "A transaction around the highlighted rows may be absent."],
          ].map(([title, value, description]) => (
            <div key={title as string} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-black text-navy-950">{title}</p>
              <p className="mt-1 text-lg font-black text-amber-700">{money(value as number)}</p>
              <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{description}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onAcceptSuggestion} className="min-h-10 rounded-lg bg-royal-600 px-4 text-sm font-black text-white">
            Mark Row as Reviewed
          </button>
          <button type="button" onClick={onReviewTransactions} className="min-h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700">
            Edit Transaction
          </button>
          <button type="button" disabled title="Manual insert is coming in a future release." className="min-h-10 cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-black text-slate-400">
            Insert Missing Transaction
          </button>
        </div>
        <p className="mt-2 text-xs font-semibold text-slate-400">Marking a row as reviewed does not change transaction amounts. Use Edit Transaction to correct values.</p>
      </div>

      <BankRecPanel run={run} totals={totals} expectedClosing={expectedClosing} difference={difference} />
    </section>
  );
}

function TransactionSnapshot({ title, transaction }: { title: string; transaction: AccountingTransaction | null }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">{title}</p>
      {transaction ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-black text-navy-950">{transaction.transactionDate || "-"}</p>
          <p className="text-sm font-semibold leading-6 text-slate-600">{transaction.description}</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <ReviewMetric label="Money in" value={money(transaction.creditAmount)} tone="text-emerald-700" />
            <ReviewMetric label="Money out" value={money(transaction.debitAmount)} tone="text-rose-700" />
            <ReviewMetric label="Balance" value={money(transaction.runningBalance)} tone="text-navy-950" />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm font-semibold text-slate-500">No transaction selected.</p>
      )}
    </div>
  );
}

function CompactSummaryBar({
  run,
  debit,
  credit,
  reviewCount,
}: {
  run: AccountingStatementRun | null;
  debit: number | null;
  credit: number | null;
  reviewCount: number;
}) {
  const items = [
    { label: "Status", value: run ? statusLabel(run.status) : "No statement", tone: run?.status === "failed" ? "text-rose-700" : run?.status === "review" ? "text-amber-700" : "text-navy-950" },
    { label: "Opening", value: money(run?.openingBalance ?? null), tone: "text-navy-950" },
    { label: "Closing", value: money(run?.closingBalance ?? null), tone: "text-navy-950" },
    { label: "Money out", value: money(debit), tone: "text-rose-700" },
    { label: "Money in", value: money(credit), tone: "text-emerald-700" },
    { label: "Review", value: plainNumber(reviewCount), tone: reviewCount ? "text-amber-700" : "text-navy-950" },
  ];

  return (
    <section className="h-24 overflow-x-auto overflow-y-hidden overscroll-y-none rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex h-full min-w-max flex-nowrap divide-x divide-slate-100 overflow-y-hidden">
        {items.map((item) => (
          <div key={item.label} className="flex h-full min-w-40 flex-[0_0_auto] flex-col justify-center px-4 py-3">
            <p className="truncate whitespace-nowrap text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">{item.label}</p>
            <p className={`mt-1 truncate whitespace-nowrap text-sm font-black ${item.tone}`}>{item.value}</p>
            {item.label === "Status" && run ? (
              <p className="mt-0.5 truncate whitespace-nowrap text-[11px] font-semibold text-slate-500">
                {run.status === "processing" || run.status === "queued" ? "Confidence: Calculating..." : `${Math.round(run.confidence)}% confidence`}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function StatementRuns({
  runs,
  selectedRunId,
  selectedRunIds,
  search,
  sortBy,
  onToggleSelected,
  onSetSelected,
  onSearchChange,
  onSortChange,
  onRefresh,
  onSelect,
}: {
  runs: AccountingStatementRun[];
  selectedRunId: string;
  selectedRunIds: string[];
  search: string;
  sortBy: string;
  onToggleSelected: (runId: string) => void;
  onSetSelected: (runIds: string[]) => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
}) {
  const router = useRouter();
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
  const allVisibleSelected = visibleRuns.length > 0 && visibleRuns.every((run) => selectedRunIds.includes(run.id));

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
        <div>
          <h2 className="text-sm font-black text-navy-950">Statements</h2>
          <p className="text-xs font-semibold text-slate-500">{runs.length} total</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:text-royal-700"
          aria-label="Refresh accounting runs"
        >
          <RefreshCcw className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-2 border-b border-slate-100 p-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search statements"
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-medium outline-none focus:border-royal-300"
          />
        </label>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(event) =>
              onSetSelected(
                event.target.checked
                  ? Array.from(new Set([...selectedRunIds, ...visibleRuns.map((run) => run.id)]))
                  : selectedRunIds.filter((id) => !visibleRuns.some((run) => run.id === id)),
              )
            }
            className="h-4 w-4 rounded border-slate-300 text-royal-600"
            aria-label="Select visible statements"
          />
          <select
            value={sortBy}
            onChange={(event) => onSortChange(event.target.value)}
            className="h-9 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 outline-none"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="month">Month</option>
            <option value="company">Company</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>
      <div className="max-h-[620px] overflow-auto">
        {visibleRuns.length ? (
          visibleRuns.map((run) => (
            <div
              key={run.id}
              onClick={() => onSelect(run.id)}
              onDoubleClick={() => router.push(`/accounting/statements/${run.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(run.id);
                }
              }}
              role="button"
              tabIndex={0}
              className={`group border-b border-slate-100 px-2 py-2 text-left transition ${
                selectedRunId === run.id ? "bg-royal-50" : "hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedRunIds.includes(run.id)}
                  onChange={(event) => {
                    event.stopPropagation();
                    onToggleSelected(run.id);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="h-4 w-4 rounded border-slate-300 text-royal-600"
                  aria-label={`Select ${runDisplayTitle(run)} for combined workbook`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/accounting/statements/${run.id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="truncate text-sm font-black text-navy-950 hover:text-royal-700 hover:underline"
                    >
                      {runDisplayTitle(run)}
                    </Link>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-slate-500">
                    <span className="truncate">{run.accountNumber || run.companyName || compactDateTime(run.createdAt)}</span>
                    <span>{run.status === "processing" || run.status === "queued" ? "Calculating..." : `${Math.round(run.confidence)}%`}</span>
                  </div>
                </div>
                <Link
                  href={`/accounting/statements/${run.id}`}
                  onClick={(event) => event.stopPropagation()}
                  className="rounded-md px-2 py-1 text-[11px] font-black text-royal-700 opacity-0 transition hover:bg-royal-50 group-hover:opacity-100"
                  aria-label={`View ${runDisplayTitle(run)}`}
                >
                  View
                </Link>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(run.id);
                  }}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
                  aria-label={`Preview ${runDisplayTitle(run)}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="p-6 text-center text-sm font-semibold text-slate-500">
            No FNB statements uploaded yet.
          </div>
        )}
        {filteredRuns.length > visibleRuns.length ? (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + 20)}
            className="min-h-10 w-full bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50"
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
  affectedTransactionIds,
  emptyLabel,
  emptyDescription,
  emptyVariant,
}: {
  transactions: AccountingTransaction[];
  patchTransaction: (transaction: AccountingTransaction, patch: AccountingTransactionPatch) => Promise<void>;
  affectedTransactionIds?: Set<string>;
  emptyLabel?: string;
  emptyDescription?: string;
  emptyVariant?: "default" | "success";
}) {
  const [mobileOffsets, setMobileOffsets] = useState<Record<string, number>>({});
  const [dismissedTransactionIds, setDismissedTransactionIds] = useState<Record<string, true>>({});
  const [mobileVisibleCount, setMobileVisibleCount] = useState(120);
  const [desktopScrollTop, setDesktopScrollTop] = useState(0);
  const touchStartRef = useRef<Record<string, { x: number; y: number }>>({});

  const mobileTransactions = transactions.filter((transaction) => !dismissedTransactionIds[transaction.id]);
  const visibleMobileTransactions = useMemo(() => mobileTransactions.slice(0, mobileVisibleCount), [mobileTransactions, mobileVisibleCount]);

  const desktopRowHeight = 44;
  const desktopViewportHeight = 500;
  const desktopWindowRows = 48;
  const desktopStart = Math.max(0, Math.floor(desktopScrollTop / desktopRowHeight) - 8);
  const desktopEnd = Math.min(transactions.length, desktopStart + desktopWindowRows);
  const desktopVisibleTransactions = useMemo(
    () => transactions.slice(desktopStart, desktopEnd),
    [transactions, desktopStart, desktopEnd],
  );
  const desktopTopSpacer = desktopStart * desktopRowHeight;
  const desktopBottomSpacer = Math.max(0, (transactions.length - desktopEnd) * desktopRowHeight);

  if (!transactions.length) {
    const isSuccess = emptyVariant === "success";
    return (
      <div className={`rounded-lg border p-8 text-center ${isSuccess ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-slate-50"}`}>
        {isSuccess ? (
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
        ) : (
          <FileSpreadsheet className="mx-auto h-8 w-8 text-royal-500" />
        )}
        <p className="mt-3 font-semibold text-navy-950">{emptyLabel ?? "No transactions in this view"}</p>
        <p className="mt-1 text-sm text-slate-500">{emptyDescription ?? "Process a statement or adjust the search filter."}</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 md:hidden">
        {visibleMobileTransactions.map((transaction) => {
          const isAffected = affectedTransactionIds?.has(transaction.id) ?? false;
          return (
          <article
            id={`transaction-${transaction.id}`}
            key={transaction.id}
            className={`relative overflow-hidden rounded-lg border ${isAffected ? "border-amber-300 bg-amber-50/60" : "border-slate-200 bg-white"}`}
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
              {isAffected ? (
                <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-1 text-xs font-black text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Possible missing bank charge
                </div>
              ) : null}
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
        );})}
        {!mobileTransactions.length ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center text-sm font-semibold text-slate-500">
            All mobile cards were dismissed in this view.
          </div>
        ) : null}
        {mobileTransactions.length > visibleMobileTransactions.length ? (
          <button
            type="button"
            onClick={() => setMobileVisibleCount((count) => count + 120)}
            className="min-h-11 w-full rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700"
          >
            Load more transactions
          </button>
        ) : null}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
        <div
          className="overflow-auto"
          style={{ maxHeight: `${desktopViewportHeight}px` }}
          onScroll={(event) => setDesktopScrollTop(event.currentTarget.scrollTop)}
        >
        <table className="w-full min-w-[1180px] text-left text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.04em] text-slate-500">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-3 py-2">In</th>
            <th className="px-3 py-2">Out</th>
            <th className="px-3 py-2">Balance</th>
            <th className="px-3 py-2">Fees</th>
            <th className="px-3 py-2">Account</th>
            <th className="px-3 py-2">VAT</th>
            <th className="px-3 py-2">Review</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {desktopTopSpacer > 0 ? (
            <tr aria-hidden>
              <td colSpan={10} style={{ height: `${desktopTopSpacer}px`, padding: 0 }} />
            </tr>
          ) : null}
          {desktopVisibleTransactions.map((transaction) => {
            const isAffected = affectedTransactionIds?.has(transaction.id) ?? false;
            return (
            <tr
              id={`transaction-${transaction.id}`}
              key={transaction.id}
              className={`align-middle hover:bg-slate-50/70 ${isAffected ? "bg-amber-50/70 ring-1 ring-inset ring-amber-200" : ""}`}
            >
              <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-600">{transaction.transactionDate || "-"}</td>
              <td className="max-w-[360px] px-3 py-2">
                <div className="flex items-center gap-2">
                  {isAffected ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : null}
                  <p className="truncate font-semibold text-navy-950">{transaction.description}</p>
                </div>
                {isAffected ? <p className="text-[10px] font-black text-amber-700">Balance mismatch · possible missing bank charge</p> : null}
                {transaction.notes ? <p className="truncate text-[10px] font-semibold text-royal-700">{transaction.notes}</p> : null}
                <p className="text-[10px] font-bold text-slate-400">{Math.round(transaction.confidence)}% confidence</p>
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-semibold text-emerald-700">{money(transaction.creditAmount)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-semibold text-rose-700">{money(transaction.debitAmount)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-bold text-navy-950">{money(transaction.runningBalance)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-600">{transaction.bankCharge ? money(transaction.debitAmount) : "-"}</td>
              <td className="px-3 py-2">
                <select
                  value={transaction.accountCategory}
                  onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                  className="w-44 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
                >
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <select
                  value={transaction.vatTreatment}
                  onChange={(event) => void patchTransaction(transaction, { vatTreatment: event.target.value as VatTreatment })}
                  className="w-32 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
                >
                  {vatTreatments.map((treatment) => (
                    <option key={treatment.value} value={treatment.value}>
                      {treatment.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() =>
                    void patchTransaction(transaction, {
                      reviewStatus: transaction.reviewStatus === "approved" ? "needs_review" : "approved",
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-black ${
                    transaction.reviewStatus === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {transaction.reviewStatus === "approved" ? <BadgeCheck className="h-3 w-3" /> : <PencilLine className="h-3 w-3" />}
                  {transaction.reviewStatus === "approved" ? "Approved" : "Review"}
                </button>
              </td>
              <td className="px-3 py-2">
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
          );})}
          {desktopBottomSpacer > 0 ? (
            <tr aria-hidden>
              <td colSpan={10} style={{ height: `${desktopBottomSpacer}px`, padding: 0 }} />
            </tr>
          ) : null}
        </tbody>
        </table>
        </div>
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
  const VAT_RATE = 15 / 115;
  const standardRows = rows.filter((row) => row.vatTreatment === "standard");
  const outputVat = standardRows.reduce((sum, row) => sum + row.credit * VAT_RATE, 0);
  const inputVat = standardRows.reduce((sum, row) => sum + row.debit * VAT_RATE, 0);
  const netVat = outputVat - inputVat;
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const totalCredit = rows.reduce((sum, row) => sum + row.credit, 0);
  const totalDebit = rows.reduce((sum, row) => sum + row.debit, 0);
  const totalEstVat = standardRows.reduce((sum, row) => sum + (row.credit + row.debit) * VAT_RATE, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Est. Output VAT", value: money(outputVat), tone: "text-emerald-700" },
          { label: "Est. Input VAT", value: money(inputVat), tone: "text-rose-700" },
          { label: "Net VAT Position", value: money(netVat), tone: netVat >= 0 ? "text-emerald-700" : "text-rose-700" },
        ].map((metric) => (
          <div key={metric.label} className="rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">{metric.label}</p>
            <p className={`mt-1 text-lg font-black ${metric.tone}`}>{metric.value}</p>
          </div>
        ))}
      </div>
      <SimpleTable
        title="VAT schedule"
        headers={["VAT treatment", "Transactions", "Money in", "Money out", "Est. VAT (15%)"]}
        rows={[
          ...rows.map((row) => [
            vatTreatments.find((item) => item.value === row.vatTreatment)?.label ?? row.vatTreatment,
            plainNumber(row.count),
            money(row.credit),
            money(row.debit),
            row.vatTreatment === "standard" ? money((row.credit + row.debit) * VAT_RATE) : "—",
          ]),
          ["Totals", plainNumber(totalCount), money(totalCredit), money(totalDebit), money(totalEstVat)],
        ]}
      />
      <p className="text-xs font-semibold text-slate-400">VAT estimated at 15% inclusive (15/115) on standard-rated transactions only. Verify against SARS VAT201 returns before filing.</p>
    </div>
  );
}

function GeneralLedgerPanel({ rows }: { rows: Array<{ account: string; debit: number; credit: number; count: number }> }) {
  const sorted = [...rows].sort((a, b) => Math.abs(b.credit - b.debit) - Math.abs(a.credit - a.debit));
  const totals = sorted.reduce((sum, row) => ({ count: sum.count + row.count, debit: sum.debit + row.debit, credit: sum.credit + row.credit }), { count: 0, debit: 0, credit: 0 });
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-400">
        Shows AI-assigned categories for all transactions including unreviewed. Approve transactions on the Review tab to confirm assignments. The exported GL uses a &ldquo;Review Required Suspense&rdquo; account for unapproved rows.
      </p>
      <SimpleTable
        title="General ledger summary"
        headers={["Account", "Transactions", "Debits", "Credits", "Net movement"]}
        rows={[
          ...sorted.map((row) => [row.account, plainNumber(row.count), money(row.debit), money(row.credit), money(row.credit - row.debit)]),
          ["Totals", plainNumber(totals.count), money(totals.debit), money(totals.credit), money(totals.credit - totals.debit)],
        ]}
      />
    </div>
  );
}

function TrialBalancePanel({ rows }: { rows: Array<{ account: string; debit: number; credit: number; count: number }> }) {
  const sorted = [...rows].sort((a, b) => {
    const aBal = Math.abs(a.debit - a.credit);
    const bBal = Math.abs(b.debit - b.credit);
    return bBal - aBal;
  });
  const totals = sorted.reduce(
    (sum, row) => {
      const balance = row.debit - row.credit;
      sum.debit += balance > 0 ? balance : 0;
      sum.credit += balance < 0 ? Math.abs(balance) : 0;
      return sum;
    },
    { debit: 0, credit: 0 },
  );
  const imbalance = Math.abs(totals.debit - totals.credit);
  const body = sorted.map((row) => {
    const balance = row.debit - row.credit;
    return [row.account, money(row.debit), money(row.credit), balance > 0 ? money(balance) : "—", balance < 0 ? money(Math.abs(balance)) : "—"];
  });
  body.push(["Totals", "—", "—", money(totals.debit), money(totals.credit)]);
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-400">
        Derived from AI-assigned transaction categories. This is not a full double-entry trial balance — the bank account itself is not represented as a contra entry.
      </p>
      {imbalance > 0.01 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
          Debit and credit balance totals differ by {money(imbalance)} — the bank account line is excluded as a contra entry. This is expected for bank statement data.
        </div>
      ) : null}
      <SimpleTable title="Trial balance" headers={["Account", "Total Debits", "Total Credits", "Dr Balance", "Cr Balance"]} rows={body} />
    </div>
  );
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

type ModuleFeature = {
  title: string;
  description: string;
  status: "live" | "in-development" | "planned";
  liveLabel?: string;
};

const moduleContent: Record<
  Exclude<AccountingModule, "bank-statements">,
  { summary: string; features: ModuleFeature[] }
> = {
  "financial-statements": {
    summary:
      "Generate financial statements directly from extracted bank statement data. Trial Balance is live now inside Bank Statements.",
    features: [
      {
        title: "Trial Balance",
        description: "Debit and credit balances by account category derived from bank data",
        status: "live",
        liveLabel: "Available in Bank Statements → Trial Balance tab",
      },
      {
        title: "Profit & Loss Statement",
        description: "Income vs expense summary for the selected statement period",
        status: "in-development",
      },
      {
        title: "Balance Sheet",
        description: "Point-in-time snapshot of assets, liabilities and equity",
        status: "in-development",
      },
      {
        title: "Cash Flow Statement",
        description: "Operating, investing and financing cash flow movements",
        status: "in-development",
      },
    ],
  },
  "tax-vat": {
    summary:
      "Identify VAT anomalies, validate treatment consistency and assess SARS risk exposure from your transaction data.",
    features: [
      {
        title: "VAT Schedule",
        description: "Full VAT treatment schedule by transaction type",
        status: "live",
        liveLabel: "Available in Bank Statements → VAT tab",
      },
      {
        title: "VAT Anomaly Detection",
        description: "Flag transactions with inconsistent, missing or conflicting VAT treatment",
        status: "in-development",
      },
      {
        title: "Input / Output VAT Summary",
        description: "Net VAT position for filing periods with supporting schedules",
        status: "in-development",
      },
      {
        title: "SARS Risk Scoring",
        description: "Risk assessment based on transaction patterns and VAT exposure",
        status: "planned",
      },
    ],
  },
  "ai-intelligence": {
    summary:
      "Transaction insights surface anomalies, duplicates and related-party activity across your bank data.",
    features: [
      {
        title: "Expense Categorisation",
        description: "Account categories are assigned to every extracted transaction automatically",
        status: "live",
        liveLabel: "Active in Bank Statements — edit categories inline",
      },
      {
        title: "Duplicate Payment Detection",
        description: "Flag transactions with matching amounts and similar descriptions in the same period",
        status: "in-development",
      },
      {
        title: "Unusual Transaction Alerts",
        description: "Identify statistical outliers by amount, frequency or counterparty pattern",
        status: "in-development",
      },
      {
        title: "Director Loan Account Analysis",
        description: "Track and classify director-linked transactions with running balance",
        status: "planned",
      },
    ],
  },
  forecasting: {
    summary:
      "Forward-looking financial intelligence built on your historical bank statement and accounting data.",
    features: [
      {
        title: "Cash Flow Forecasting",
        description: "Project future cash positions from historical inflow and outflow patterns",
        status: "planned",
      },
      {
        title: "Monthly Management Accounts",
        description: "Automated draft management accounts generated from processed bank data",
        status: "planned",
      },
      {
        title: "Financial Ratio Analysis",
        description: "Liquidity, solvency and profitability ratios with period-on-period comparison",
        status: "planned",
      },
      {
        title: "Budget vs Actual",
        description: "Compare extracted actuals against imported budget figures",
        status: "planned",
      },
    ],
  },
  "audit-tools": {
    summary:
      "Purpose-built tools for auditors, accountants and tax practitioners working with bank statement data.",
    features: [
      {
        title: "Statement Notes",
        description: "Narrative notes summarising statement activity and anomalies",
        status: "in-development",
      },
      {
        title: "Audit Trail Insights",
        description: "Full processing history, confidence scoring log and change tracking",
        status: "in-development",
      },
      {
        title: "Audit Preparation Pack",
        description: "Generate an auditor-ready document package with supporting schedules",
        status: "planned",
      },
      {
        title: "Working Paper Support",
        description: "Structured working papers exportable to Excel with sign-off fields",
        status: "planned",
      },
    ],
  },
};

const featureStatusConfig: Record<
  "live" | "in-development" | "planned",
  { label: string; badge: string; card: string; note: string }
> = {
  live: {
    label: "Live",
    badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
    card: "border-emerald-200 bg-emerald-50/30",
    note: "text-emerald-700",
  },
  "in-development": {
    label: "In Development",
    badge: "border-amber-200 bg-amber-50 text-amber-700",
    card: "border-amber-100 bg-white",
    note: "text-amber-700",
  },
  planned: {
    label: "Planned",
    badge: "border-slate-200 bg-slate-100 text-slate-500",
    card: "border-slate-200 bg-slate-50",
    note: "text-slate-400",
  },
};

// ─── Module No-Data Message ────────────────────────────────────────────────

function ModuleNoDataMessage({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center shadow-sm">
      <FileText className="h-10 w-10 text-slate-300" />
      <div>
        <p className="text-base font-bold text-navy-950">{label}</p>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Process a bank statement first to unlock this module.
        </p>
      </div>
      <button
        onClick={onSelect}
        className="rounded-xl bg-royal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-royal-700"
      >
        Go to Bank Statements
      </button>
    </div>
  );
}

// ─── Sub-tabs helper ───────────────────────────────────────────────────────

function SubTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-all ${
            active === tab.id
              ? "bg-white text-navy-950 shadow-sm"
              : "text-slate-500 hover:text-navy-950"
          }`}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? (
            <span
              className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-black ${
                active === tab.id
                  ? "bg-royal-50 text-royal-700"
                  : "bg-slate-200 text-slate-500"
              }`}
            >
              {tab.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ─── Financial Statements Panel ────────────────────────────────────────────

function FinancialStatementsPanel({
  pl,
  cashFlow,
  ratios,
}: {
  pl: ProfitLossData;
  cashFlow: CashFlowData;
  ratios: FinancialRatios;
}) {
  const [activeTab, setActiveTab] = useState<"pl" | "cashflow" | "ratios">("pl");
  const fmt = (v: number) =>
    `R${Math.abs(v).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-royal-600" />
        <h2 className="text-base font-bold text-navy-950">Financial Statements</h2>
      </div>
      <SubTabs
        tabs={[
          { id: "pl", label: "Profit & Loss" },
          { id: "cashflow", label: "Cash Flow" },
          { id: "ratios", label: "Ratios" },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      {activeTab === "pl" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Revenue", value: pl.totalRevenue, color: "text-emerald-700" },
              { label: "Expenses", value: pl.totalExpenses, color: "text-rose-700" },
              {
                label: pl.netSurplus >= 0 ? "Net Surplus" : "Net Deficit",
                value: pl.netSurplus,
                color: pl.netSurplus >= 0 ? "text-emerald-700" : "text-rose-700",
              },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
                <p className={`mt-1 truncate text-lg font-black ${m.color}`}>{fmt(m.value)}</p>
              </div>
            ))}
          </div>

          <div>
            <p className="mb-2 text-xs font-black uppercase tracking-wide text-emerald-700">Income</p>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-black text-slate-500">Category</th>
                    <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Count</th>
                    <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pl.revenue.map((row) => (
                    <tr key={row.category}>
                      <td className="px-3 py-2 font-semibold text-navy-950">{row.category}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-500">{row.count}</td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">{fmt(row.amount)}</td>
                    </tr>
                  ))}
                  <tr className="bg-emerald-50/50">
                    <td className="px-3 py-2 font-black text-emerald-900" colSpan={2}>Total Revenue</td>
                    <td className="px-3 py-2 text-right font-black text-emerald-900">{fmt(pl.totalRevenue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-black uppercase tracking-wide text-rose-700">Expenses</p>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-black text-slate-500">Category</th>
                    <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Count</th>
                    <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pl.expenses.map((row) => (
                    <tr key={row.category}>
                      <td className="px-3 py-2 font-semibold text-navy-950">{row.category}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-500">{row.count}</td>
                      <td className="px-3 py-2 text-right font-bold text-rose-700">{fmt(row.amount)}</td>
                    </tr>
                  ))}
                  <tr className="bg-rose-50/50">
                    <td className="px-3 py-2 font-black text-rose-900" colSpan={2}>Total Expenses</td>
                    <td className="px-3 py-2 text-right font-black text-rose-900">{fmt(pl.totalExpenses)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {pl.interAccountTransfers > 0 ? (
            <p className="text-xs font-semibold text-slate-400">
              * Inter-account transfers ({fmt(pl.interAccountTransfers)}) excluded from P&L.
            </p>
          ) : null}

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-start gap-2 text-xs font-semibold text-amber-800">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {pl.note}
            </p>
          </div>
        </div>
      ) : activeTab === "cashflow" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Opening Balance", value: cashFlow.openingBalance, color: "text-navy-950" },
              { label: "Closing Balance", value: cashFlow.closingBalance, color: "text-navy-950" },
              {
                label: "Total Inflows",
                value: cashFlow.totalInflows,
                color: "text-emerald-700",
              },
              {
                label: "Total Outflows",
                value: cashFlow.totalOutflows,
                color: "text-rose-700",
              },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
                <p className={`mt-1 truncate text-base font-black ${m.color}`}>
                  {m.value !== null && m.value !== undefined ? fmt(m.value) : "—"}
                </p>
              </div>
            ))}
          </div>

          {!cashFlow.reconciled ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Opening balance + net movement does not reconcile with the closing balance. Check for missing transactions.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-black uppercase tracking-wide text-emerald-700">Inflows</p>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {cashFlow.inflows.map((row) => (
                      <tr key={row.label}>
                        <td className="px-3 py-2 font-semibold text-navy-950">{row.label}</td>
                        <td className="px-3 py-2 text-right font-bold text-emerald-700">{fmt(row.amount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-50/50">
                      <td className="px-3 py-2 font-black text-emerald-900">Total</td>
                      <td className="px-3 py-2 text-right font-black text-emerald-900">{fmt(cashFlow.totalInflows)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-black uppercase tracking-wide text-rose-700">Outflows</p>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {cashFlow.outflows.map((row) => (
                      <tr key={row.label}>
                        <td className="px-3 py-2 font-semibold text-navy-950">{row.label}</td>
                        <td className="px-3 py-2 text-right font-bold text-rose-700">{fmt(row.amount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-rose-50/50">
                      <td className="px-3 py-2 font-black text-rose-900">Total</td>
                      <td className="px-3 py-2 text-right font-black text-rose-900">{fmt(cashFlow.totalOutflows)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-start gap-2 text-xs font-semibold text-amber-800">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {cashFlow.note}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              {
                label: "Expense Ratio",
                value: ratios.expenseRatio !== null ? `${(ratios.expenseRatio * 100).toFixed(1)}%` : "—",
                note: "Expenses ÷ Revenue",
                color: ratios.expenseRatio !== null && ratios.expenseRatio > 0.9 ? "text-rose-700" : "text-navy-950",
              },
              {
                label: "Net Cash Margin",
                value: ratios.netCashMargin !== null ? `${ratios.netCashMargin.toFixed(1)}%` : "—",
                note: "(Revenue − Expenses) ÷ Revenue",
                color: ratios.netCashMargin !== null && ratios.netCashMargin < 0 ? "text-rose-700" : "text-emerald-700",
              },
              {
                label: "Cash Coverage",
                value: ratios.cashCoverageRatio !== null ? `${ratios.cashCoverageRatio.toFixed(2)}×` : "—",
                note: "Revenue ÷ Expenses",
                color: ratios.cashCoverageRatio !== null && ratios.cashCoverageRatio < 1 ? "text-rose-700" : "text-navy-950",
              },
              {
                label: "Avg Monthly Income",
                value: ratios.avgMonthlyIncome !== null ? `R${ratios.avgMonthlyIncome.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}` : "—",
                note: `Over ${ratios.periodMonths} month${ratios.periodMonths > 1 ? "s" : ""}`,
                color: "text-emerald-700",
              },
              {
                label: "Avg Monthly Expenses",
                value: ratios.avgMonthlyExpenses !== null ? `R${ratios.avgMonthlyExpenses.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}` : "—",
                note: `Over ${ratios.periodMonths} month${ratios.periodMonths > 1 ? "s" : ""}`,
                color: "text-rose-700",
              },
              {
                label: "Bank Charges Ratio",
                value: ratios.bankChargesRatio !== null ? `${ratios.bankChargesRatio.toFixed(2)}%` : "—",
                note: "Bank charges ÷ Expenses",
                color: "text-navy-950",
              },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
                <p className={`mt-1 truncate text-xl font-black ${m.color}`}>{m.value}</p>
                <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{m.note}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-start gap-2 text-xs font-semibold text-amber-800">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {ratios.note}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tax & VAT Panel ───────────────────────────────────────────────────────

function TaxVatPanel({
  vatRows,
  vatAnomalies,
  riskScore,
}: {
  vatRows: { vatTreatment: VatTreatment; debit: number; credit: number; count: number }[];
  vatAnomalies: VatAnomaly[];
  riskScore: SarsRiskScore;
}) {
  const [activeTab, setActiveTab] = useState<"schedule" | "anomalies" | "risk">("schedule");
  const fmt = (v: number) =>
    `R${Math.abs(v).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const VAT_RATE = 15 / 115;
  const standardRow = vatRows.find((r) => r.vatTreatment === "standard");
  const estOutputVat = (standardRow?.credit ?? 0) * VAT_RATE;
  const estInputVat = (standardRow?.debit ?? 0) * VAT_RATE;
  const netVat = estOutputVat - estInputVat;

  const TREATMENT_LABELS: Record<VatTreatment, string> = {
    standard: "Standard Rated (15%)",
    zero_rated: "Zero Rated (0%)",
    exempt: "Exempt",
    out_of_scope: "Out of Scope",
    review: "Review Required",
  };

  const severityColors: Record<string, string> = {
    high: "border-rose-200 bg-rose-50 text-rose-800",
    medium: "border-amber-200 bg-amber-50 text-amber-800",
    low: "border-slate-200 bg-slate-50 text-slate-700",
  };

  const riskColors: Record<string, string> = {
    low: "text-emerald-700",
    moderate: "text-amber-700",
    elevated: "text-orange-700",
    high: "text-rose-700",
  };

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <Scale className="h-5 w-5 text-royal-600" />
        <h2 className="text-base font-bold text-navy-950">Tax & VAT Intelligence</h2>
      </div>
      <SubTabs
        tabs={[
          { id: "schedule", label: "VAT Schedule" },
          { id: "anomalies", label: "Anomalies", count: vatAnomalies.length },
          { id: "risk", label: "SARS Risk" },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      {activeTab === "schedule" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Est. Output VAT", value: estOutputVat, color: "text-emerald-700" },
              { label: "Est. Input VAT", value: estInputVat, color: "text-rose-700" },
              {
                label: netVat >= 0 ? "Net VAT Payable" : "Net VAT Refund",
                value: netVat,
                color: netVat >= 0 ? "text-amber-700" : "text-emerald-700",
              },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
                <p className={`mt-1 truncate text-lg font-black ${m.color}`}>{fmt(m.value)}</p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-black text-slate-500">Treatment</th>
                  <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Txns</th>
                  <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Money In</th>
                  <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Money Out</th>
                  <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Est. VAT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {vatRows.map((row) => {
                  const rowVat =
                    row.vatTreatment === "standard"
                      ? (row.credit + row.debit) * VAT_RATE
                      : null;
                  return (
                    <tr key={row.vatTreatment}>
                      <td className="px-3 py-2 font-semibold text-navy-950">
                        {TREATMENT_LABELS[row.vatTreatment] ?? row.vatTreatment}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-500">{row.count}</td>
                      <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                        {row.credit > 0 ? fmt(row.credit) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-rose-700">
                        {row.debit > 0 ? fmt(row.debit) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-navy-950">
                        {rowVat !== null ? fmt(rowVat) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs font-semibold text-slate-400">
            VAT estimated at 15% inclusive (15/115) on standard-rated transactions only. Verify against SARS VAT201 returns. Not tax advice.
          </p>
        </div>
      ) : activeTab === "anomalies" ? (
        <div className="space-y-3">
          {vatAnomalies.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-sm font-semibold text-emerald-800">No VAT anomalies detected in this statement.</p>
            </div>
          ) : (
            vatAnomalies.map((anomaly) => (
              <div
                key={anomaly.id}
                className={`rounded-xl border p-4 ${severityColors[anomaly.severity]}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <p className="text-xs font-black uppercase tracking-wide">
                        {anomaly.severity === "high" ? "High" : anomaly.severity === "medium" ? "Medium" : "Low"} Severity
                      </p>
                    </div>
                    <p className="mt-1 text-sm font-semibold">{anomaly.description}</p>
                  </div>
                  <p className="shrink-0 text-sm font-black">{fmt(anomaly.amount)}</p>
                </div>
                <p className="mt-1 text-xs font-semibold opacity-70">
                  {anomaly.transactionIds.length} transaction{anomaly.transactionIds.length > 1 ? "s" : ""} affected
                </p>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div>
              <p className="text-sm font-bold text-slate-500">Internal Advisory Risk Score</p>
              <p className={`mt-1 text-4xl font-black ${riskColors[riskScore.level]}`}>
                {riskScore.score}<span className="text-base font-semibold text-slate-400">/100</span>
              </p>
              <p className={`mt-0.5 text-sm font-bold capitalize ${riskColors[riskScore.level]}`}>{riskScore.level}</p>
            </div>
            <Shield className={`h-12 w-12 opacity-20 ${riskColors[riskScore.level]}`} />
          </div>

          <p className="text-sm font-semibold text-slate-600">{riskScore.summary}</p>

          <div className="space-y-2">
            {riskScore.factors.map((factor) => (
              <div key={factor.name} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-navy-950">{factor.name}</p>
                  <p className="text-sm font-black text-navy-950">
                    {factor.score}<span className="text-xs font-semibold text-slate-400">/{factor.maxScore}</span>
                  </p>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full transition-all ${
                      factor.score / factor.maxScore > 0.6
                        ? "bg-rose-500"
                        : factor.score / factor.maxScore > 0.3
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                    style={{ width: `${(factor.score / factor.maxScore) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-xs font-semibold text-slate-500">{factor.detail}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-500">
              <strong>Disclaimer:</strong> This is an internal advisory score based on bank statement data only. It does not represent a SARS assessment, guarantee of compliance, or tax advice. Engage a registered tax practitioner before any SARS submission.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Transaction Insights Panel ───────────────────────────────────────────

function AiTransactionPanel({
  duplicates,
  unusuals,
  directors,
}: {
  duplicates: DuplicateGroup[];
  unusuals: UnusualTransaction[];
  directors: DirectorTransaction[];
}) {
  const [activeTab, setActiveTab] = useState<"duplicates" | "unusuals" | "directors">("duplicates");
  const fmt = (v: number) =>
    `R${Math.abs(v).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-5 w-5 text-royal-600" />
        <h2 className="text-base font-bold text-navy-950">Transaction Insights</h2>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: "Duplicates",
            count: duplicates.length,
            color: duplicates.length > 0 ? "text-rose-700" : "text-emerald-700",
          },
          {
            label: "Unusual",
            count: unusuals.length,
            color: unusuals.length > 0 ? "text-amber-700" : "text-emerald-700",
          },
          {
            label: "Director Activity",
            count: directors.length,
            color: directors.length > 0 ? "text-amber-700" : "text-navy-950",
          },
        ].map((m) => (
          <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
            <p className={`mt-1 text-2xl font-black ${m.color}`}>{m.count}</p>
          </div>
        ))}
      </div>

      <SubTabs
        tabs={[
          { id: "duplicates", label: "Duplicates", count: duplicates.length },
          { id: "unusuals", label: "Unusual", count: unusuals.length },
          { id: "directors", label: "Director", count: directors.length },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      {activeTab === "duplicates" ? (
        <div className="space-y-3">
          {duplicates.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-sm font-semibold text-emerald-800">No duplicate payments detected.</p>
            </div>
          ) : (
            duplicates.map((group) => (
              <div key={group.id} className="rounded-xl border border-rose-200 bg-rose-50/50 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Copy className="h-4 w-4 text-rose-600" />
                    <p className="text-sm font-bold text-rose-900">
                      {group.transactions.length} matching payments — {fmt(group.amount)} each
                    </p>
                  </div>
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700">
                    {group.confidence}% confidence
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {group.transactions.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-navy-950">{t.description}</p>
                        <p className="text-[10px] font-semibold text-slate-400">{t.transactionDate ?? "—"}</p>
                      </div>
                      <p className="ml-2 shrink-0 text-xs font-black text-rose-700">{fmt(t.debitAmount ?? 0)}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : activeTab === "unusuals" ? (
        <div className="space-y-3">
          {unusuals.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-sm font-semibold text-emerald-800">No statistically unusual transactions detected.</p>
            </div>
          ) : (
            unusuals.map((u) => (
              <div
                key={u.transaction.id}
                className={`rounded-xl border p-4 ${
                  u.severity === "high"
                    ? "border-rose-200 bg-rose-50/50"
                    : "border-amber-200 bg-amber-50/50"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-navy-950">{u.transaction.description}</p>
                    <p className="text-xs font-semibold text-slate-500">{u.transaction.transactionDate ?? "—"}</p>
                    <p
                      className={`mt-1 text-xs font-semibold ${
                        u.severity === "high" ? "text-rose-700" : "text-amber-700"
                      }`}
                    >
                      {u.reason}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-black text-navy-950">
                    {fmt((u.transaction.debitAmount ?? u.transaction.creditAmount) ?? 0)}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {directors.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <Info className="h-4 w-4 text-slate-400" />
              <p className="text-sm font-semibold text-slate-600">No director or related-party transactions detected.</p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="flex items-start gap-2 text-xs font-semibold text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Director loans and related-party transactions require disclosure under IAS 24. Confirm nature and obtain supporting documentation.
                </p>
              </div>
              {directors.map((d) => (
                <div key={d.transaction.id} className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50/30 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-navy-950">{d.transaction.description}</p>
                    <p className="text-xs font-semibold text-slate-500">
                      {d.transaction.transactionDate ?? "—"} · matched: <span className="font-bold text-amber-700">{d.matchedKeyword}</span>
                    </p>
                  </div>
                  <p className="ml-2 shrink-0 text-sm font-black text-navy-950">
                    {fmt((d.transaction.debitAmount ?? d.transaction.creditAmount) ?? 0)}
                  </p>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Forecasting Panel ─────────────────────────────────────────────────────

function ForecastPanel({
  forecast,
  ratios,
  run,
}: {
  forecast: ForecastData;
  ratios: FinancialRatios;
  run: AccountingStatementRun;
}) {
  const fmt = (v: number) =>
    `R${Math.abs(v).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  void ratios;

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-royal-600" />
        <h2 className="text-base font-bold text-navy-950">Cash Flow Forecast</h2>
        {run.companyName ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
            {run.companyName}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          {
            label: "Monthly Avg Income",
            value: fmt(forecast.monthlyAvgIncome),
            sub: `over ${forecast.periodMonths} month${forecast.periodMonths > 1 ? "s" : ""}`,
            color: "text-emerald-700",
          },
          {
            label: "Monthly Avg Expenses",
            value: fmt(forecast.monthlyAvgExpenses),
            sub: `over ${forecast.periodMonths} month${forecast.periodMonths > 1 ? "s" : ""}`,
            color: "text-rose-700",
          },
          {
            label: forecast.monthlyNetFlow >= 0 ? "Monthly Net Surplus" : "Monthly Net Deficit",
            value: fmt(forecast.monthlyNetFlow),
            sub: "income minus expenses",
            color: forecast.monthlyNetFlow >= 0 ? "text-emerald-700" : "text-rose-700",
          },
        ].map((m) => (
          <div key={m.label} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">{m.label}</p>
            <p className={`mt-1 truncate text-lg font-black ${m.color}`}>{m.value}</p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{m.sub}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">3-Month Projection</p>
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-black text-slate-500">Month</th>
                <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Income</th>
                <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Expenses</th>
                <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Net Flow</th>
                <th className="px-3 py-2 text-right text-xs font-black text-slate-500">Closing Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {forecast.currentBalance !== null ? (
                <tr className="bg-slate-50/50">
                  <td className="px-3 py-2 font-semibold text-slate-500">Current</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">—</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">—</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">—</td>
                  <td className="px-3 py-2 text-right font-bold text-navy-950">{fmt(forecast.currentBalance)}</td>
                </tr>
              ) : null}
              {forecast.projections.map((proj) => (
                <tr key={proj.label}>
                  <td className="px-3 py-2 font-semibold text-navy-950">{proj.label}</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(proj.projectedIncome)}</td>
                  <td className="px-3 py-2 text-right font-semibold text-rose-700">{fmt(proj.projectedExpenses)}</td>
                  <td
                    className={`px-3 py-2 text-right font-bold ${
                      proj.projectedNetFlow >= 0 ? "text-emerald-700" : "text-rose-700"
                    }`}
                  >
                    {proj.projectedNetFlow >= 0 ? "+" : ""}{fmt(proj.projectedNetFlow)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-black ${
                      proj.projectedClosingBalance >= 0 ? "text-navy-950" : "text-rose-700"
                    }`}
                  >
                    {fmt(proj.projectedClosingBalance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {forecast.periodMonths === 1 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="flex items-start gap-2 text-xs font-semibold text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Forecast based on a single month. Process 3+ statement periods for a reliable baseline.
          </p>
        </div>
      ) : (
        <p className="text-xs font-semibold text-slate-400">{forecast.note}</p>
      )}
    </div>
  );
}

// ─── Audit Tools Panel ─────────────────────────────────────────────────────

function AuditToolsPanel({
  auditSummary,
  run,
  transactions,
}: {
  auditSummary: AuditSummary;
  run: AccountingStatementRun;
  transactions: AccountingTransaction[];
}) {
  const [activeTab, setActiveTab] = useState<"findings" | "checklist" | "ai">("findings");
  const [aiResult, setAiResult] = useState<AiCommentaryResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiType, setAiType] = useState<AiCommentaryType>("executive-summary");

  const SEVERITY_COLORS: Record<string, string> = {
    critical: "border-rose-300 bg-rose-50 text-rose-900",
    high: "border-rose-200 bg-rose-50/60 text-rose-800",
    medium: "border-amber-200 bg-amber-50 text-amber-800",
    low: "border-slate-200 bg-slate-50 text-slate-700",
    info: "border-blue-200 bg-blue-50 text-blue-800",
  };

  const SEVERITY_LABEL: Record<string, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    info: "Info",
  };

  const riskColors: Record<string, string> = {
    low: "text-emerald-700 bg-emerald-50 border-emerald-200",
    moderate: "text-amber-700 bg-amber-50 border-amber-200",
    elevated: "text-orange-700 bg-orange-50 border-orange-200",
    high: "text-rose-700 bg-rose-50 border-rose-200",
  };

  const checklist = [
    {
      label: "Review queue cleared",
      done: auditSummary.reviewItems === 0,
      detail: auditSummary.reviewItems > 0 ? `${auditSummary.reviewItems} items remain` : "All items reviewed",
    },
    {
      label: "All transactions categorised",
      done: auditSummary.uncategorized === 0,
      detail: auditSummary.uncategorized > 0 ? `${auditSummary.uncategorized} uncategorised` : "All categorised",
    },
    {
      label: "No duplicate payments",
      done: auditSummary.riskScore.factors.find((f) => f.name === "Duplicate Payments")?.score === 0,
      detail: "Check Transaction Insights > Duplicates tab",
    },
    {
      label: "VAT anomalies resolved",
      done: auditSummary.riskScore.factors.find((f) => f.name === "VAT Anomalies")?.score === 0,
      detail: "Check Tax & VAT > Anomalies tab",
    },
    {
      label: "Invoices linked (R5k+ payments)",
      done: auditSummary.transactionsNeedingInvoice.length === 0,
      detail:
        auditSummary.transactionsNeedingInvoice.length > 0
          ? `${auditSummary.transactionsNeedingInvoice.length} without invoice`
          : "All supported",
    },
    {
      label: "Statement exported for accountant",
      done: false,
      detail: "Use the Export button on Bank Statements",
    },
  ];

  const completedCount = checklist.filter((c) => c.done).length;

  async function fetchAiCommentary(type: AiCommentaryType) {
    setAiType(type);
    setAiLoading(true);
    setAiResult(null);
    try {
      const res = await fetch("/api/accounting/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, type }),
      });
      if (res.ok) {
        const data = (await res.json()) as AiCommentaryResult;
        setAiResult(data);
      }
    } finally {
      setAiLoading(false);
    }
  }

  void transactions;

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-royal-600" />
        <h2 className="text-base font-bold text-navy-950">Audit Tools</h2>
        <div
          className={`ml-auto rounded-full border px-3 py-1 text-xs font-black capitalize ${riskColors[auditSummary.riskScore.level]}`}
        >
          Risk: {auditSummary.riskScore.level} ({auditSummary.riskScore.score}/100)
        </div>
      </div>

      <SubTabs
        tabs={[
          { id: "findings", label: "Findings", count: auditSummary.findings.length },
          { id: "checklist", label: "Checklist" },
          { id: "ai", label: "Notes" },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      {activeTab === "findings" ? (
        <div className="space-y-3">
          {auditSummary.findings.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-sm font-semibold text-emerald-800">No audit findings. Statement appears complete and well-classified.</p>
            </div>
          ) : (
            auditSummary.findings.map((finding) => (
              <div key={finding.id} className={`rounded-xl border p-4 ${SEVERITY_COLORS[finding.severity]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide">
                        {SEVERITY_LABEL[finding.severity]}
                      </span>
                      <span className="text-[10px] font-black uppercase tracking-wide opacity-60">
                        {finding.category}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-bold">{finding.title}</p>
                    <p className="mt-0.5 text-xs font-semibold opacity-70">{finding.detail}</p>
                  </div>
                  {finding.count !== undefined && (
                    <span className="shrink-0 text-xl font-black">{finding.count}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ) : activeTab === "checklist" ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-500">
              Pre-export checklist — {completedCount}/{checklist.length} complete
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-black ${
                completedCount === checklist.length
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {completedCount === checklist.length ? "Ready" : "In Progress"}
            </span>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${(completedCount / checklist.length) * 100}%` }}
            />
          </div>

          <div className="space-y-2">
            {checklist.map((item, i) => (
              <div
                key={i}
                className={`flex items-center gap-3 rounded-xl border p-3 ${
                  item.done
                    ? "border-emerald-200 bg-emerald-50/50"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    item.done
                      ? "border-emerald-500 bg-emerald-500"
                      : "border-slate-300 bg-white"
                  }`}
                >
                  {item.done ? <CheckCircle2 className="h-3 w-3 text-white" /> : null}
                </div>
                <div>
                  <p
                    className={`text-sm font-bold ${
                      item.done ? "text-emerald-800 line-through decoration-emerald-400" : "text-navy-950"
                    }`}
                  >
                    {item.label}
                  </p>
                  <p className="text-xs font-semibold text-slate-500">{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "executive-summary" as AiCommentaryType, label: "Executive Summary" },
                { id: "audit-notes" as AiCommentaryType, label: "Audit Notes" },
                { id: "vat-commentary" as AiCommentaryType, label: "VAT Commentary" },
                { id: "risk-explanation" as AiCommentaryType, label: "Risk Explanation" },
                { id: "forecast-commentary" as AiCommentaryType, label: "Forecast Notes" },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                onClick={() => void fetchAiCommentary(btn.id)}
                disabled={aiLoading}
                className={`rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                  aiType === btn.id && aiResult
                    ? "border-royal-300 bg-royal-50 text-royal-700"
                    : "border-slate-200 bg-slate-50 text-slate-600 hover:border-royal-200 hover:bg-royal-50 hover:text-royal-700"
                } disabled:opacity-50`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {aiLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-8">
              <Loader2 className="h-5 w-5 animate-spin text-royal-600" />
              <p className="text-sm font-semibold text-slate-500">Generating commentary…</p>
            </div>
          ) : aiResult ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold leading-relaxed text-navy-950">{aiResult.commentary}</p>
              </div>
              {aiResult.keyPoints.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-black uppercase tracking-wide text-slate-500">Key Points</p>
                  <ul className="space-y-1">
                    {aiResult.keyPoints.map((point, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs font-semibold text-navy-950">
                        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-royal-500" />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {aiResult.recommendations.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-black uppercase tracking-wide text-slate-500">Recommendations</p>
                  <ul className="space-y-1">
                    {aiResult.recommendations.map((rec, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs font-semibold text-navy-950">
                        <TrendingDown className="mt-0.5 h-3 w-3 shrink-0 text-royal-500" />
                        {rec}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center">
              <p className="text-sm font-semibold text-slate-500">
                Select a commentary type above to generate AI-assisted accounting notes.
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-400">
                Uses OpenAI if configured, otherwise generates rule-based notes.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── AccountingModulePanel (legacy — no longer used for live modules) ──────

function AccountingModulePanel({
  moduleId,
}: {
  moduleId: Exclude<AccountingModule, "bank-statements">;
}) {
  const mod = accountingModules.find((m) => m.id === moduleId)!;
  const content = moduleContent[moduleId];
  const modStatus = featureStatusConfig[mod.status];

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-black ${modStatus.badge}`}>
              {modStatus.label}
            </span>
            <h2 className="mt-3 text-xl font-semibold text-navy-950">{mod.label}</h2>
            <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-slate-500">{content.summary}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {content.features.map((feature) => {
          const cfg = featureStatusConfig[feature.status];
          return (
            <div key={feature.title} className={`rounded-xl border p-4 ${cfg.card}`}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold text-navy-950">{feature.title}</h3>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-black ${cfg.badge}`}>
                  {cfg.label}
                </span>
              </div>
              <p className="mt-1 text-sm leading-5 text-slate-500">{feature.description}</p>
              {feature.liveLabel ? (
                <p className={`mt-3 text-xs font-semibold ${cfg.note}`}>{feature.liveLabel}</p>
              ) : feature.status === "in-development" ? (
                <p className={`mt-3 text-xs font-semibold ${cfg.note}`}>Coming in a future release</p>
              ) : (
                <p className={`mt-3 text-xs font-semibold ${cfg.note}`}>On the roadmap</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

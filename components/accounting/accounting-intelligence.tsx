"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, BadgeCheck, FileSpreadsheet, Loader2, PencilLine, Play, RefreshCcw, UploadCloud } from "lucide-react";
import type {
  AccountingRunDetail,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
  VatTreatment,
} from "@/lib/accounting/types";

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

function money(value: number | null) {
  if (value === null) return "-";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(value);
}

function statusLabel(status: AccountingStatementRun["status"]) {
  const labels: Record<AccountingStatementRun["status"], string> = {
    queued: "Queued",
    processing: "Processing",
    review: "Ready for review",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[status];
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

export function AccountingIntelligence() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [runs, setRuns] = useState<AccountingStatementRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [detail, setDetail] = useState<AccountingRunDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
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
      const data = (await response.json().catch(() => ({}))) as { error?: string; workerDetail?: unknown; workerRawBody?: string; workerStatus?: number };
      if (!response.ok) {
        setDiagnostics(formatDiagnostics(data));
        throw new Error(formatApiError(data, "Processing failed."));
      }
      setMessage("FNB statement processed. Review the extracted transactions.");
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

  const totals = useMemo(() => {
    const transactions = detail?.transactions ?? [];
    return {
      debit: transactions.reduce((sum, transaction) => sum + (transaction.debitAmount ?? 0), 0),
      credit: transactions.reduce((sum, transaction) => sum + (transaction.creditAmount ?? 0), 0),
      review: transactions.filter((transaction) => transaction.reviewStatus === "needs_review").length,
    };
  }, [detail]);

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <section
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files.item(0);
          if (file) void uploadFile(file);
        }}
        className="rounded-[2rem] border border-dashed border-royal-200 bg-white p-6 shadow-sm"
      >
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-royal-600">FNB South Africa only</p>
            <h2 className="mt-2 text-2xl font-black text-navy-950">Upload an FNB business bank statement PDF</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              DocuCoreX stores the PDF, creates an accounting extraction job, sends it to the Python worker, and prepares an editable accounting review pack.
            </p>
          </div>
          <div className="rounded-3xl bg-royal-50 p-5 text-center">
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
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-5 py-3 text-sm font-black text-white shadow-glow transition hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Choose FNB PDF
            </button>
            <p className="mt-3 text-xs font-semibold text-slate-500">Drag and drop is supported. Max 200 MB.</p>
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

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black text-navy-950">Statement Runs</h2>
              <p className="mt-1 text-sm text-slate-500">Uploaded FNB statements and processing state.</p>
            </div>
            <button
              type="button"
              onClick={() => void loadRuns().catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Refresh failed."))}
              className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:text-royal-700"
              aria-label="Refresh accounting runs"
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-2">
            {runs.length ? (
              runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => {
                    setSelectedRunId(run.id);
                    void loadRunDetail(run.id).catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Unable to open run."));
                  }}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    selectedRunId === run.id ? "border-royal-300 bg-royal-50" : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-black text-navy-950">{run.companyName || "FNB statement"}</p>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-royal-700">{statusLabel(run.status)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-500">{run.accountNumber || run.sourceStoragePath.split("/").pop()}</p>
                  <p className="mt-2 text-xs font-bold text-slate-400">{new Date(run.createdAt).toLocaleString()}</p>
                </button>
              ))
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">No FNB statements uploaded yet.</div>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          {selectedRun && detail ? (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-royal-600">{selectedRun.bank}</p>
                  <h2 className="mt-2 text-2xl font-black text-navy-950">{detail.run.companyName || "Accounting review"}</h2>
                  <p className="mt-2 text-sm text-slate-500">
                    Account {detail.run.accountNumber || "pending"} · {detail.run.transactionCount || detail.transactions.length} transactions · Confidence{" "}
                    {Math.round(detail.run.confidence)}%
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy === `process:${detail.run.id}` || detail.run.status === "processing"}
                    onClick={() => void processRun(detail.run.id)}
                    className="inline-flex items-center gap-2 rounded-2xl bg-navy-950 px-4 py-2.5 text-sm font-black text-white hover:bg-royal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {busy === `process:${detail.run.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Process
                  </button>
                  <a
                    href={`/api/accounting/fnb/export/${detail.run.id}`}
                    className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-black ${
                      detail.run.workbookStoragePath ? "bg-royal-600 text-white hover:bg-royal-700" : "pointer-events-none bg-slate-100 text-slate-400"
                    }`}
                  >
                    <ArrowDownToLine className="h-4 w-4" />
                    Export Workbook
                  </a>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  ["Opening balance", money(detail.run.openingBalance)],
                  ["Closing balance", money(detail.run.closingBalance)],
                  ["Debits", money(totals.debit)],
                  ["Review items", totals.review.toLocaleString()],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
                    <p className="mt-2 text-lg font-black text-navy-950">{value}</p>
                  </div>
                ))}
              </div>

              {detail.transactions.length ? (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="min-w-[1100px] w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                      <tr>
                        <th className="px-4 py-3">Date</th>
                        <th className="px-4 py-3">Description</th>
                        <th className="px-4 py-3">Debit</th>
                        <th className="px-4 py-3">Credit</th>
                        <th className="px-4 py-3">Category</th>
                        <th className="px-4 py-3">VAT</th>
                        <th className="px-4 py-3">Invoice</th>
                        <th className="px-4 py-3">Review</th>
                        <th className="px-4 py-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {detail.transactions.map((transaction) => (
                        <tr key={transaction.id} className="align-top">
                          <td className="px-4 py-3 font-bold text-slate-600">{transaction.transactionDate || "-"}</td>
                          <td className="max-w-[260px] px-4 py-3">
                            <p className="font-black text-navy-950">{transaction.description}</p>
                            <p className="mt-1 text-xs font-bold text-slate-400">Confidence {Math.round(transaction.confidence)}%</p>
                          </td>
                          <td className="px-4 py-3 font-bold text-rose-700">{money(transaction.debitAmount)}</td>
                          <td className="px-4 py-3 font-bold text-emerald-700">{money(transaction.creditAmount)}</td>
                          <td className="px-4 py-3">
                            <select
                              value={transaction.accountCategory}
                              onChange={(event) => void patchTransaction(transaction, { accountCategory: event.target.value })}
                              className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold outline-none focus:border-royal-300"
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
                              className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold outline-none focus:border-royal-300"
                            >
                              {vatTreatments.map((treatment) => (
                                <option key={treatment.value} value={treatment.value}>
                                  {treatment.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={transaction.supportedByInvoice}
                              onChange={(event) => void patchTransaction(transaction, { supportedByInvoice: event.target.checked })}
                              className="h-5 w-5 rounded border-slate-300 text-royal-600"
                              aria-label={`Invoice support for ${transaction.description}`}
                            />
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
                            <input
                              value={transaction.notes}
                              onChange={(event) => void patchTransaction(transaction, { notes: event.target.value })}
                              placeholder="Add note"
                              className="w-48 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-royal-300"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
                  <FileSpreadsheet className="mx-auto h-8 w-8 text-royal-500" />
                  <p className="mt-3 font-black text-navy-950">No extracted transactions yet</p>
                  <p className="mt-1 text-sm text-slate-500">Click Process to send this FNB statement to the accounting worker.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
              <FileSpreadsheet className="mx-auto h-8 w-8 text-royal-500" />
              <p className="mt-3 font-black text-navy-950">Select or upload an FNB statement</p>
              <p className="mt-1 text-sm text-slate-500">The review screen appears once a statement run exists.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

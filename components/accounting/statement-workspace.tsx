"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DEFAULT_VISIBLE_COLUMNS,
  TRANSACTION_COLUMNS,
  loadVisibleColumns,
  normalizeVisibleColumns,
  saveVisibleColumns,
  type TransactionColumnId,
} from "@/lib/accounting/transaction-columns";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  RefreshCcw,
  Search,
  FileWarning,
  Loader2,
  ListChecks,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import type {
  AccountingRunDetail,
  AccountingStatementRun,
  AccountingTransaction,
  AccountingTransactionPatch,
  VatTreatment,
} from "@/lib/accounting/types";
import { buildAccountingModel } from "@/lib/accounting/model";
import { VAT_TREATMENT_OPTIONS, categoryOptionsFor, isUnresolvedAccountingCategory } from "@/lib/accounting/review-options";
import { cleanStatementLabel, statementDisplayName } from "@/lib/accounting/statement-name";
import { parserMethodLabel } from "@/lib/pdf/workerHandoff";
import { pollRunUntilTerminal } from "@/lib/accounting/poll-run";
import { detectDuplicates, detectUnusualTransactions, detectDirectorTransactions } from "@/lib/accounting/analytics";
import { accountingRunQuality, accountingTransactionTotals } from "@/lib/accounting/run-quality";
import { DocumentViewer } from "@/components/document-viewer";
import { ProcessingSteps } from "@/components/accounting/processing-steps";
import { mergeAccountingRunProgress } from "@/lib/accounting/processing-stage";
import { FailedRunPanel } from "@/components/accounting/failed-run-panel";

// ── Formatting helpers ───────────────────────────────────────────────────────

const fmtMoney = (value: number | null | undefined) =>
  `R${(value ?? 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
};

const VAT_LABEL: Record<string, string> = {
  standard: "STD",
  zero_rated: "ZR",
  exempt: "EX",
  out_of_scope: "OOS",
  review: "REV",
};

const EXPORT_OPTIONS: Array<{ label: string; section: string }> = [
  { label: "Full Accounting Pack", section: "all" },
  { label: "Transactions", section: "transactions" },
  { label: "Executive Summary", section: "summary" },
  { label: "VAT Working Paper", section: "vat" },
  { label: "General Ledger", section: "general-ledger" },
  { label: "Provisional Ledger", section: "trial-balance" },
  { label: "Profit & Loss", section: "profit-loss" },
  { label: "Balance Sheet", section: "balance-sheet" },
  { label: "Cash Flow", section: "cash-flow" },
  { label: "Bank Reconciliation", section: "bank-reconciliation" },
  { label: "Review Queue", section: "review-queue" },
  { label: "Transaction Insights Report", section: "transaction-insights" },
];

type Tab = "transactions" | "review" | "insights" | "difference" | "summary" | "reconciliation" | "vat" | "ledger" | "trial-balance";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "transactions", label: "Transactions" },
  { id: "review", label: "Review" },
  { id: "insights", label: "Transaction Insights" },
  { id: "difference", label: "Difference Inspector" },
  { id: "summary", label: "Summary" },
  { id: "reconciliation", label: "Bank Reconciliation" },
  { id: "vat", label: "VAT" },
  { id: "ledger", label: "General Ledger" },
  { id: "trial-balance", label: "Provisional Ledger" },
];

function runTitle(run: AccountingStatementRun): string {
  // Name from the statement's own period end / date — never the upload date.
  return statementDisplayName(run);
}

function isReviewItem(t: AccountingTransaction): boolean {
  return (
    t.reviewStatus === "needs_review" ||
    t.reviewStatus === "in_review" ||
    t.vatTreatment === "review" ||
    /uncategori|review required|suspense/i.test(t.accountCategory)
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StatementWorkspace({ statementId }: { statementId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<AccountingRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("transactions");
  const [busy, setBusy] = useState<null | "reprocess" | "regenerate" | "cancel">(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Page of the statement to show for the transaction the user picked. The
  // nonce lets the same transaction be selected twice and still return to its
  // page. Transactions whose sourcePage is null simply never set this.
  const [previewJump, setPreviewJump] = useState<{ page: number; nonce: number } | null>(null);
  // Which pane shows below lg. Defaults to the work surface, matching the
  // default Transactions tab; selecting a transaction switches to the statement.
  const [mobilePane, setMobilePane] = useState<"statement" | "transactions">("transactions");
  const jumpNonce = useRef(0);
  const runProgressRef = useRef<AccountingStatementRun | null>(null);
  const showTransactionInStatement = useCallback((page: number | null) => {
    if (!page || page < 1) return;
    jumpNonce.current += 1;
    setPreviewJump({ page, nonce: jumpNonce.current });
    // On mobile the statement pane is hidden, so the jump would be invisible
    // and the tap would read as doing nothing. Bring it into view.
    setMobilePane("statement");
  }, []);

  const sourceUrl = `/api/accounting/fnb/runs/${statementId}/source`;

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/accounting/fnb/runs/${statementId}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || "Unable to load statement.");
      }
      const incoming = (await response.json()) as AccountingRunDetail;
      const acceptedRun = mergeAccountingRunProgress(runProgressRef.current, incoming.run);
      runProgressRef.current = acceptedRun;
      setDetail({ ...incoming, run: acceptedRun });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load statement.");
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const patchTransaction = useCallback(
    async (transaction: AccountingTransaction, patch: AccountingTransactionPatch) => {
      // Optimistic update.
      setDetail((current) =>
        current
          ? { ...current, transactions: current.transactions.map((t) => (t.id === transaction.id ? { ...t, ...patch } : t)) }
          : current,
      );
      try {
        const response = await fetch(`/api/accounting/fnb/transactions/${transaction.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = (await response.json().catch(() => ({}))) as { transaction?: AccountingTransaction; error?: string };
        if (!response.ok || !body.transaction) throw new Error(body.error || "Change could not be saved.");
        setDetail((current) =>
          current
            ? { ...current, transactions: current.transactions.map((t) => (t.id === transaction.id ? body.transaction! : t)) }
            : current,
        );
      } catch (saveError) {
        setBanner(saveError instanceof Error ? saveError.message : "Change could not be saved. Refresh and try again.");
        void loadDetail().catch(() => undefined);
      }
    },
    [loadDetail],
  );

  async function reprocess() {
    setBusy("reprocess");
    setBanner(null);
    try {
      const response = await fetch("/api/accounting/fnb/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: statementId, reprocess: true }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Re-processing failed.");
      // Processing runs in the background now — poll until the run is terminal.
      setBanner("Re-processing… extracting and reconciling in the background.");
      const outcome = await pollRunUntilTerminal(statementId, { onTick: () => void loadDetail().catch(() => undefined) });
      await loadDetail();
      if (outcome.timedOut) setBanner("Still processing — taking longer than usual. Refresh to check the latest status.");
      else if (outcome.status === "failed") setBanner(outcome.error || "Re-processing failed.");
      else if (outcome.status === "review") setBanner("Review required before final export. Draft export is available.");
      else setBanner("Statement re-processed. Latest extraction loaded.");
    } catch (reprocessError) {
      setBanner(reprocessError instanceof Error ? reprocessError.message : "Re-processing failed.");
    } finally {
      setBusy(null);
    }
  }

  async function cancelProcessing() {
    setBusy("cancel");
    setBanner(null);
    try {
      const response = await fetch(`/api/accounting/fnb/runs/${statementId}/cancel`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to cancel processing.");
      await loadDetail();
      setBanner("Processing cancelled. You can retry when ready.");
    } catch (cancelError) {
      setBanner(cancelError instanceof Error ? cancelError.message : "Unable to cancel processing.");
    } finally {
      setBusy(null);
    }
  }

  function regenerateWorkbook() {
    // Rebuild the workbook from already-extracted data (no PDF re-read).
    setBusy("regenerate");
    setBanner("Regenerating workbook from extracted data…");
    window.location.href = `/api/accounting/fnb/export/${statementId}?section=all`;
    window.setTimeout(() => setBusy(null), 1500);
  }

  async function deleteStatement() {
    if (!window.confirm("Delete this statement and its extracted data? This cannot be undone.")) return;
    try {
      await fetch(`/api/accounting/fnb/runs/${statementId}`, { method: "DELETE" });
      router.push("/accounting");
    } catch {
      setBanner("Unable to delete statement.");
    }
  }

  const run = detail?.run ?? null;
  const transactions = detail?.transactions ?? [];
  const model = useMemo(() => (detail ? buildAccountingModel(detail) : null), [detail]);
  const runQuality = useMemo(() => accountingRunQuality(detail), [detail]);

  // Opening a statement is READ-ONLY.
  //
  // This used to reprocess it on mount whenever the saved totals looked stale —
  // the same defect as in accounting-intelligence.tsx, duplicated. The useRef
  // guard was per mounted component, so it reset on every open, refresh and
  // navigation. The notice below reports the finding; the existing Re-process
  // Statement button is how a user acts on it.

  const totals = useMemo(() => {
    const transactionTotals = accountingTransactionTotals(transactions);
    const moneyIn = transactionTotals.credit;
    const moneyOut = transactionTotals.debit;
    const charges = run?.bankChargesTotal || transactionTotals.bankCharges;
    const opening = run?.openingBalance ?? 0;
    const closing = run?.closingBalance ?? 0;
    const expectedClosing = opening + moneyIn - moneyOut;
    const difference = expectedClosing - closing;
    return { moneyIn, moneyOut, charges, opening, closing, expectedClosing, difference, reconciled: Math.abs(difference) < 0.01 };
  }, [transactions, run]);

  const reviewItems = useMemo(() => transactions.filter(isReviewItem), [transactions]);

  // Only the FIRST load replaces the workspace. A refresh must not, because
  // loadDetail() sets loading on every poll tick — so a reprocess unmounted the
  // whole tree, and with it the PDF viewer, several times a minute. That is what
  // made the statement appear and then vanish, and what drove the viewer's
  // teardown into the error boundary. Keeping the tree mounted during a refresh
  // is also simply correct: the data is already on screen.
  if (loading && !detail) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> <span className="text-sm font-semibold">Opening statement workspace…</span>
        </div>
      </div>
    );
  }

  if (error || !run || !model) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <FileWarning className="mx-auto h-10 w-10 text-amber-500" />
        <h1 className="mt-3 text-lg font-black text-navy-950">Statement unavailable</h1>
        <p className="mt-1 text-sm font-semibold text-slate-500">{error || "This statement could not be loaded."}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button onClick={() => void loadDetail()} className="rounded-lg bg-royal-600 px-4 py-2 text-sm font-bold text-white hover:bg-royal-700">
            Retry
          </button>
          <Link href="/accounting" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
            Back to Statements
          </Link>
        </div>
      </div>
    );
  }

  const dataQuality = runQuality.needsFreshExtraction ? "May Need Reprocessing" : totals.reconciled ? "Complete" : totals.opening === 0 && totals.closing === 0 ? "Unable to Verify" : "Review Required";
  const fullPackBlocked = run.status === "queued" || run.status === "processing" || transactions.length === 0;

  return (
    <div className="px-4 py-4 sm:px-6 lg:px-8">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link href="/accounting" className="inline-flex items-center gap-1.5 text-sm font-bold text-royal-700 hover:text-royal-800">
              <ArrowLeft className="h-4 w-4" /> Back to Statements
            </Link>
            <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              Accounting Intelligence <span className="text-slate-300">›</span> Bank Statements <span className="text-slate-300">›</span>{" "}
              <span className="text-slate-500">{runTitle(run)}</span>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-black text-navy-950">{runTitle(run)}</h1>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-black ${
                  dataQuality === "Complete" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                }`}
              >
                {dataQuality}
              </span>
              {/* The review state belongs beside the title: it is the first
                  thing that decides whether this statement can be exported.
                  Same condition the advisory line below already uses. */}
              {run.requiresReview || run.validationStatus === "review_required" ? (
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-black text-amber-800">Review Required</span>
              ) : null}
              {run.parserMethod ? (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-600">{parserMethodLabel(run.parserMethod)}</span>
              ) : null}
            </div>

            {/* Scale of the work, directly under the title. Both figures are
                already derived — run.transactionCount from the run, and
                reviewItems from getReviewItems — so this counts nothing new. */}
            <p className="mt-1 text-xs font-bold text-slate-600">
              {(run.transactionCount || 0).toLocaleString("en-ZA")} transactions
              {reviewItems.length ? (
                <>
                  <span className="mx-1.5 text-slate-300">·</span>
                  <span className="text-amber-700">{reviewItems.length.toLocaleString("en-ZA")} review items</span>
                </>
              ) : null}
            </p>
            {runQuality.needsFreshExtraction ? (
              <p className="mt-1 text-xs font-bold text-amber-700">
                May need reprocessing — {runQuality.reason} Use Re-process Statement when you are ready.
              </p>
            ) : run.requiresReview || run.validationStatus === "review_required" ? (
              <p className="mt-1 text-xs font-bold text-amber-700">Review required before final export. Draft export is available.</p>
            ) : null}
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {run.bank} · Account {cleanStatementLabel(run.accountNumber) || "—"} ·{" "}
              {run.statementPeriodStart || run.statementPeriodEnd
                ? `${fmtDate(run.statementPeriodStart)} – ${fmtDate(run.statementPeriodEnd)}`
                : "Period not detected"}
            </p>
          </div>

          {/* Top actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void reprocess()}
              disabled={busy === "reprocess" || busy === "cancel"}
              title="Re-reads the original PDF and extracts the transactions again."
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {busy === "reprocess" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />} Re-process Statement
            </button>
            {(run.status === "processing" || run.status === "queued") ? (
              <button
                onClick={() => void cancelProcessing()}
                disabled={busy === "reprocess" || busy === "cancel"}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Cancel Processing
              </button>
            ) : null}
            <button
              onClick={regenerateWorkbook}
              disabled={busy === "regenerate"}
              title="Rebuilds the Excel workbook from already-extracted data without re-reading the PDF."
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <Download className="h-4 w-4" /> Regenerate Workbook
            </button>
            <div className="relative">
              <button
                onClick={() => {
                  setExportOpen((o) => !o);
                  setMoreOpen(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700"
              >
                Export <ChevronDown className="h-4 w-4" />
              </button>
              {exportOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                  {EXPORT_OPTIONS.map((option, index) => (
                    option.section === "all" && fullPackBlocked ? (
                      <button
                        key={option.section}
                        type="button"
                        disabled
                        className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-bold text-slate-300 ${
                          index === 0 ? "border-b border-slate-100" : ""
                        }`}
                      >
                        {option.label}
                        <span className="mt-1 block text-[11px] font-semibold text-amber-700">
                          Wait for processing to finish before exporting.
                        </span>
                      </button>
                    ) : (
                      <a
                        key={option.section}
                        href={`/api/accounting/fnb/export/${statementId}?section=${option.section}`}
                        onClick={() => setExportOpen(false)}
                        className={`block rounded-lg px-3 py-2 text-sm font-bold text-slate-700 hover:bg-royal-50 hover:text-royal-700 ${
                          index === 0 ? "border-b border-slate-100" : ""
                        }`}
                      >
                        {option.label}
                      </a>
                    )
                  ))}
                </div>
              ) : null}
            </div>
            <div className="relative">
              <button
                onClick={() => {
                  setMoreOpen((o) => !o);
                  setExportOpen(false);
                }}
                className="inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {moreOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
                  <a
                    href={`${sourceUrl}?download=1`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMoreOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                  >
                    Download original PDF
                  </a>
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      void loadDetail();
                    }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-sm font-bold text-slate-700 hover:bg-slate-50"
                  >
                    Refresh data
                  </button>
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      void deleteStatement();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-bold text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="h-4 w-4" /> Delete statement
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {banner ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">{banner}</div> : null}
        {detail?.run.status === "processing" || busy === "reprocess" ? (
          <ProcessingSteps step={detail?.run.processingStep ?? null} startedAt={detail?.run.processingStartedAt ?? null} updatedAt={detail?.run.updatedAt ?? null} ocrUsed={detail?.run.ocrUsed ?? null} />
        ) : null}
        {detail?.run.status === "failed" ? (
          <FailedRunPanel run={detail.run} busy={busy === "reprocess" || busy === "cancel"} onRetryWithoutForce={() => void reprocess()} onRetry={() => void reprocess()} />
        ) : null}
      </div>

      {/* ── Summary metrics ─────────────────────────────────────────────
          The same figures the sidebar already derived from `totals`, lifted
          into one compact horizontal row so they read at a glance instead of
          as a vertical list competing with the document for width. No new
          calculations: every value comes from the existing totals, run and
          reviewItems. */}
      <StatementMetrics
        run={run}
        totals={totals}
        reviewCount={reviewItems.length}
        stale={runQuality.needsFreshExtraction}
      />

      {/* ── Statement + transactions, side by side ──────────────────────
          Was three columns (300px sidebar | document | 460px tools), which
          left the document a middle strip and the tools too narrow for a
          transaction table. Now two panes at roughly 36/64: the document on
          the left, the work surface on the right, starting on the same line.
          The sidebar's remaining detail moves below — see StatementSidebar. */}
      {/* Below lg the panes cannot sit side by side and stay legible, so one
          shows at a time. Stacking them instead meant scrolling past a 520px
          document to reach the first transaction. Both stay MOUNTED — the
          inactive one is display:none — so switching never re-fetches or
          re-renders the PDF, and the viewer keeps its page and zoom. */}
      <div className="mt-3 flex rounded-lg border border-slate-200 bg-white p-1 lg:hidden" role="tablist" aria-label="Statement or transactions">
        {([
          { id: "statement", label: "Statement" },
          { id: "transactions", label: "Transactions" },
        ] as const).map((pane) => (
          <button
            key={pane.id}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane.id}
            onClick={() => setMobilePane(pane.id)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-bold transition ${
              mobilePane === pane.id ? "bg-royal-600 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {pane.label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,36fr)_minmax(0,64fr)]">
        <div className={mobilePane === "statement" ? "min-w-0" : "hidden min-w-0 lg:block"}>
          <DocumentViewer sourceUrl={sourceUrl} downloadUrl={`${sourceUrl}?download=1`} fileName={`${runTitle(run)}.pdf`} kind="pdf" jumpToPage={previewJump} />
        </div>
        <div className={`min-w-0 xl:row-span-1 ${mobilePane === "transactions" ? "" : "hidden lg:block"}`}>
          <RightPanel
            statementId={statementId}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            run={run}
            transactions={transactions}
            model={model}
            totals={totals}
            reviewItems={reviewItems}
            patchTransaction={patchTransaction}
            onShowInStatement={showTransactionInStatement}
          />
        </div>
      </div>

      {/* ── Statement detail + status ────────────────────────────────────
          Relocated from the left column so the document and the transaction
          table get the full width. Nothing is dropped: the same two cards,
          the same rows, and both Review actions still call setActiveTab. */}
      <StatementSidebar run={run} totals={totals} reviewCount={reviewItems.length} dataQuality={dataQuality} stale={runQuality.needsFreshExtraction} onReview={() => setActiveTab("review")} />

      {/* ── Bottom quick review + notes ─────────────────────────────────── */}
      <QuickReview model={model} transactions={transactions} totals={totals} onOpenReview={() => setActiveTab("review")} />
      <NotesPanel statementId={statementId} />
    </div>
  );
}

// ── Summary metrics ───────────────────────────────────────────────────────────

/**
 * One compact horizontal row of the figures that matter at a glance. Every
 * value is already computed upstream — `totals` from the reconciliation logic,
 * `transactionCount` from the run, `reviewCount` from getReviewItems — so this
 * presents existing numbers and calculates nothing of its own.
 */
function StatementMetrics({
  run,
  totals,
  reviewCount,
  stale,
}: {
  run: AccountingStatementRun;
  totals: { moneyIn: number; moneyOut: number; opening: number; closing: number };
  reviewCount: number;
  stale: boolean;
}) {
  const refreshing = (value: string) => (stale ? "Refreshing…" : value);
  const cards: Array<{ label: string; value: string; detail: string; tone?: "in" | "out" | "review" }> = [
    { label: "Transactions", value: String(run.transactionCount || 0), detail: "Total in statement" },
    { label: "Review Items", value: String(reviewCount), detail: "Need your review", tone: reviewCount ? "review" : undefined },
    { label: "Opening Balance", value: fmtMoney(totals.opening), detail: fmtDate(run.statementPeriodStart) || "—" },
    { label: "Money In", value: refreshing(fmtMoney(totals.moneyIn)), detail: "Received", tone: "in" },
    { label: "Money Out", value: refreshing(fmtMoney(totals.moneyOut)), detail: "Paid out", tone: "out" },
    { label: "Closing Balance", value: fmtMoney(totals.closing), detail: fmtDate(run.statementPeriodEnd) || "—" },
  ];

  return (
    // Horizontally scrollable on narrow screens rather than wrapping into a
    // tall block that pushes the statement itself below the fold.
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <dl className="grid min-w-max grid-cols-6 gap-2 sm:min-w-0 sm:gap-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className="min-w-[140px] rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:min-w-0"
          >
            <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{card.label}</dt>
            <dd
              className={`mt-1 truncate text-lg font-black tabular-nums ${
                card.tone === "in"
                  ? "text-emerald-700"
                  : card.tone === "out"
                    ? "text-rose-700"
                    : card.tone === "review"
                      ? "text-amber-700"
                      : "text-navy-950"
              }`}
              title={card.value}
            >
              {card.value}
            </dd>
            <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{card.detail}</p>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Left sidebar ──────────────────────────────────────────────────────────────

function StatementSidebar({
  run,
  totals,
  reviewCount,
  dataQuality,
  stale,
  onReview,
}: {
  run: AccountingStatementRun;
  totals: { moneyIn: number; moneyOut: number; charges: number; opening: number; closing: number; difference: number; reconciled: boolean };
  reviewCount: number;
  dataQuality: string;
  stale: boolean;
  onReview: () => void;
}) {
  return (
    /* Two columns now that this sits below the split rather than beside it. */
    <aside className="grid gap-4 md:grid-cols-2">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-black text-navy-950">Statement Details</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Bank" value={run.bank} />
          <Row label="Company" value={cleanStatementLabel(run.companyName) || "—"} />
          <Row label="Account Number" value={cleanStatementLabel(run.accountNumber) || "—"} />
          <Row label="Statement Period" value={run.statementPeriodStart || run.statementPeriodEnd ? `${fmtDate(run.statementPeriodStart)} – ${fmtDate(run.statementPeriodEnd)}` : "—"} />
          <Row label="Currency" value="ZAR" />
          <Row label="Opening Balance" value={fmtMoney(totals.opening)} />
          <Row label="Money In" value={stale ? "Refreshing…" : fmtMoney(totals.moneyIn)} tone={stale ? "warn" : undefined} />
          <Row label="Money Out" value={stale ? "Refreshing…" : fmtMoney(totals.moneyOut)} tone={stale ? "warn" : undefined} />
          <Row label="Closing Balance" value={fmtMoney(totals.closing)} />
          <Row label="Bank Charges" value={fmtMoney(totals.charges)} />
        </dl>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-black text-navy-950">Status &amp; Quality</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Reconciliation" value={stale ? "Refreshing" : totals.reconciled ? "Reconciled" : "Review Required"} tone={totals.reconciled && !stale ? "good" : "warn"} />
          <Row label="Difference" value={stale ? "Refreshing…" : fmtMoney(totals.difference)} tone={totals.reconciled && !stale ? "good" : "warn"} />
          <Row label="Data Quality" value={dataQuality} tone={dataQuality === "Complete" ? "good" : "warn"} />
          <Row label="Transactions Extracted" value={String(run.transactionCount || 0)} />
          <Row label="Review Items" value={String(reviewCount)} tone={reviewCount ? "warn" : "good"} />
        </dl>
        <div className="mt-3 grid gap-2">
          <button onClick={onReview} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700">
            <ListChecks className="h-4 w-4" /> Review Transactions
          </button>
          <button onClick={onReview} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
            Jump to Review Queue
          </button>
        </div>
      </section>
    </aside>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`text-right text-sm font-bold ${tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-navy-950"}`}>{value}</dd>
    </div>
  );
}

// ── Right panel (tabs) ────────────────────────────────────────────────────────

type Model = ReturnType<typeof buildAccountingModel>;

function RightPanel({
  statementId,
  activeTab,
  setActiveTab,
  run,
  transactions,
  model,
  totals,
  reviewItems,
  patchTransaction,
  onShowInStatement,
}: {
  statementId: string;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  run: AccountingStatementRun;
  transactions: AccountingTransaction[];
  model: Model;
  totals: { moneyIn: number; moneyOut: number; charges: number; opening: number; closing: number; expectedClosing: number; difference: number; reconciled: boolean };
  reviewItems: AccountingTransaction[];
  patchTransaction: (t: AccountingTransaction, patch: AccountingTransactionPatch) => Promise<void>;
  /** Show a transaction's page in the statement preview. */
  onShowInStatement: (page: number | null) => void;
}) {
  return (
    <section className="flex min-h-[520px] flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap gap-1 border-b border-slate-100 p-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-black transition ${
              activeTab === tab.id ? "bg-royal-600 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {tab.label}
            {tab.id === "review" && reviewItems.length ? <span className="ml-1 rounded-full bg-amber-200 px-1.5 text-[10px] text-amber-800">{reviewItems.length}</span> : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {activeTab === "transactions" ? <TransactionsTab model={model} onShowInStatement={onShowInStatement} /> : null}
        {activeTab === "review" ? <ReviewTab reviewItems={reviewItems} patchTransaction={patchTransaction} /> : null}
        {activeTab === "insights" ? <InsightsTab statementId={statementId} transactions={transactions} model={model} totals={totals} /> : null}
        {activeTab === "difference" ? <DifferenceTab totals={totals} model={model} /> : null}
        {activeTab === "summary" ? <SummaryTab run={run} model={model} totals={totals} reviewCount={reviewItems.length} /> : null}
        {activeTab === "reconciliation" ? <ReconciliationTab totals={totals} /> : null}
        {activeTab === "vat" ? <VatTab model={model} /> : null}
        {activeTab === "ledger" ? <LedgerTab model={model} opening={totals.opening} /> : null}
        {activeTab === "trial-balance" ? <TrialBalanceTab model={model} reconciled={totals.reconciled} /> : null}
      </div>
    </section>
  );
}

function statusTone(status: string): string {
  if (status === "approved" || status === "ready" || status === "resolved") return "bg-emerald-100 text-emerald-800";
  return "bg-amber-100 text-amber-800";
}

function TransactionsTab({
  model,
  onShowInStatement,
}: {
  model: Model;
  /** Show a transaction's page in the statement preview. */
  onShowInStatement: (page: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<TransactionColumnId[]>(DEFAULT_VISIBLE_COLUMNS);
  const [columnsOpen, setColumnsOpen] = useState(false);

  // Read the stored preference after mount. Reading it during render would make
  // the server and client markup disagree, since localStorage does not exist on
  // the server — so the first paint is deliberately the default layout.
  useEffect(() => {
    setVisibleColumns(loadVisibleColumns());
  }, []);

  const shown = useMemo(() => new Set(visibleColumns), [visibleColumns]);
  const columns = useMemo(() => TRANSACTION_COLUMNS.filter((column) => shown.has(column.id)), [shown]);

  const toggleColumn = (id: TransactionColumnId) => {
    setVisibleColumns((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      const normalized = normalizeVisibleColumns(next);
      saveVisibleColumns(normalized);
      return normalized;
    });
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? model.transactions.filter((t) => `${t.description} ${t.category} ${t.reference}`.toLowerCase().includes(q)) : model.transactions;
  }, [model.transactions, query]);
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <label className="relative block flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search transactions" className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm font-medium outline-none focus:border-royal-300" />
        </label>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setColumnsOpen((open) => !open)}
            aria-expanded={columnsOpen}
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-600 hover:bg-slate-50"
          >
            Columns
          </button>
          {columnsOpen ? (
            <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
              {TRANSACTION_COLUMNS.map((column) => (
                <label
                  key={column.id}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs font-semibold ${
                    column.locked ? "text-slate-400" : "cursor-pointer text-navy-950 hover:bg-slate-50"
                  }`}
                  title={column.locked ? "Always shown — a transaction cannot be identified without it." : undefined}
                >
                  <input
                    type="checkbox"
                    checked={shown.has(column.id)}
                    disabled={column.locked}
                    onChange={() => toggleColumn(column.id)}
                  />
                  {column.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="overflow-auto rounded-lg border border-slate-100">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              {columns.map((column) => (
                <th key={column.id} className={`px-2 py-2 font-black ${column.align === "right" ? "text-right" : ""}`}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              /* Selecting a row shows its page in the statement preview. Only
                 rows the extractor recorded a page for are actionable — the
                 rest stay inert rather than pretending to navigate. There are
                 no bounding boxes in the data, so this jumps to the page and
                 makes no claim to highlight a region. */
              <tr
                key={t.id}
                onClick={t.sourcePage ? () => onShowInStatement(t.sourcePage) : undefined}
                title={t.sourcePage ? `Show page ${t.sourcePage} of the statement` : undefined}
                className={`border-t border-slate-100 hover:bg-slate-50 ${t.sourcePage ? "cursor-pointer" : ""}`}
              >
                {columns.map((column) => {
                  switch (column.id) {
                    case "date":
                      return <td key={column.id} className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">{fmtDate(t.date)}</td>;
                    case "description":
                      return (
                        <td key={column.id} className="max-w-[180px] truncate px-2 py-1.5 font-semibold text-navy-950" title={t.description}>
                          {t.description}
                          {t.bankCharge ? <span className="ml-1 rounded bg-slate-100 px-1 text-[9px] font-black text-slate-500">FEE</span> : null}
                        </td>
                      );
                    case "credit":
                      return <td key={column.id} className="px-2 py-1.5 text-right font-bold text-emerald-700">{t.credit ? fmtMoney(t.credit) : ""}</td>;
                    case "debit":
                      return <td key={column.id} className="px-2 py-1.5 text-right font-bold text-slate-700">{t.debit ? fmtMoney(t.debit) : ""}</td>;
                    case "balance":
                      return <td key={column.id} className="px-2 py-1.5 text-right font-semibold text-slate-500">{t.balance != null ? fmtMoney(t.balance) : "—"}</td>;
                    case "category":
                      return <td key={column.id} className="max-w-[120px] truncate px-2 py-1.5 font-semibold text-slate-600" title={t.category}>{t.category}</td>;
                    case "gl":
                      return <td key={column.id} className="px-2 py-1.5 font-semibold text-slate-500">{t.account.number}</td>;
                    case "vat":
                      return <td key={column.id} className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${t.vatCode === "REV" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{t.vatCode}</span></td>;
                    case "status":
                      return <td key={column.id} className="px-2 py-1.5"><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black ${statusTone(t.reviewStatus)}`}>{t.reviewStatus}</span></td>;
                    case "sourcePage":
                      // "—" rather than a blank: no recorded page is a fact
                      // about the extraction, not a missing cell.
                      return <td key={column.id} className="px-2 py-1.5 font-semibold text-slate-500">{t.sourcePage ?? "—"}</td>;
                    default:
                      return null;
                  }
                })}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-2 py-6 text-center text-sm font-semibold text-slate-400">No transactions match.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewTab({ reviewItems, patchTransaction }: { reviewItems: AccountingTransaction[]; patchTransaction: (t: AccountingTransaction, patch: AccountingTransactionPatch) => Promise<void> }) {
  // Focused review is one decision at a time with a position counter; the list
  // stays available because scanning a whole queue and working through it one
  // item at a time are different jobs, and neither replaces the other.
  const [focused, setFocused] = useState(true);
  const [index, setIndex] = useState(0);

  // The queue shrinks as items are approved, so an index held across a change
  // can point past the end. Clamping on length change keeps the position valid
  // without resetting the accountant to the top of the queue on every save.
  const clampedIndex = reviewItems.length ? Math.min(index, reviewItems.length - 1) : 0;
  useEffect(() => {
    setIndex((current) => (reviewItems.length ? Math.min(current, reviewItems.length - 1) : 0));
  }, [reviewItems.length]);

  const step = useCallback(
    (delta: number) => {
      setIndex((current) => {
        const next = current + delta;
        if (next < 0 || next > reviewItems.length - 1) return current;
        return next;
      });
    },
    [reviewItems.length],
  );

  // Arrow keys only move the queue when the accountant is not typing or
  // choosing in a field — otherwise left/right inside a text box would jump the
  // transaction out from under the edit being made.
  useEffect(() => {
    if (!focused || !reviewItems.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, reviewItems.length, step]);

  if (!reviewItems.length) {
    return <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">Nothing to review — all transactions are categorised with resolved VAT.</div>;
  }
  const canApproveAndRemember = (transaction: AccountingTransaction) =>
    !isUnresolvedAccountingCategory(transaction.accountCategory) && transaction.vatTreatment !== "review";
  const approveAndRemember = (transaction: AccountingTransaction) =>
    patchTransaction(transaction, {
      reviewStatus: "approved",
      notes: transaction.notes || "Approved and saved for future supplier matching.",
    });
  const renderItem = (t: AccountingTransaction) => (
        <div key={t.id} className="rounded-lg border border-amber-200 bg-amber-50/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-black text-navy-950" title={t.description}>{t.description}</p>
              <p className="text-xs font-semibold text-slate-500">
                {fmtDate(t.transactionDate)} · {t.debitAmount ? `Out ${fmtMoney(t.debitAmount)}` : `In ${fmtMoney(t.creditAmount)}`} · {t.accountCategory}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-black text-amber-800">
              {t.vatTreatment === "review" ? "VAT review" : /suspense|uncategori|review/i.test(t.accountCategory) ? "Categorise" : "Verify"}
            </span>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-[1.2fr_0.8fr_auto_auto_auto]">
            <select
              value={t.accountCategory}
              onChange={(event) => void patchTransaction(t, { accountCategory: event.target.value })}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
              aria-label="Accounting category"
            >
              {categoryOptionsFor(t.accountCategory).map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
            <select
              value={t.vatTreatment}
              onChange={(event) => void patchTransaction(t, { vatTreatment: event.target.value as VatTreatment })}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-navy-950 outline-none focus:border-royal-300"
              aria-label="VAT treatment"
            >
              {VAT_TREATMENT_OPTIONS.map((treatment) => (
                <option key={treatment.value} value={treatment.value}>
                  {treatment.label}
                </option>
              ))}
            </select>
            <label className="inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600">
              <input
                type="checkbox"
                checked={t.supportedByInvoice}
                onChange={(event) => void patchTransaction(t, { supportedByInvoice: event.target.checked })}
              />
              Invoice
            </label>
            <button
              type="button"
              disabled={!canApproveAndRemember(t)}
              title={canApproveAndRemember(t) ? "Approve this category and VAT treatment, then remember this supplier next time." : "Choose a final category and VAT treatment before approving."}
              onClick={() => void approveAndRemember(t)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                canApproveAndRemember(t)
                  ? "bg-royal-600 text-white hover:bg-royal-700"
                  : "cursor-not-allowed bg-slate-100 text-slate-400"
              }`}
            >
              {canApproveAndRemember(t) ? "Approve & remember" : "Set category/VAT"}
            </button>
            <button onClick={() => void patchTransaction(t, { reviewStatus: "resolved", notes: t.notes || "Ignored during review." })} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">Ignore</button>
          </div>
        </div>
  );

  const current = reviewItems[clampedIndex];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-wide text-amber-700">
          Review required — {reviewItems.length} {reviewItems.length === 1 ? "item" : "items"}
        </p>
        <div className="flex items-center gap-1">
          {focused ? (
            <>
              <span className="px-1 text-xs font-black text-slate-500" aria-live="polite">
                {clampedIndex + 1} of {reviewItems.length}
              </span>
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={clampedIndex === 0}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={clampedIndex >= reviewItems.length - 1}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
              >
                Next
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setFocused((value) => !value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-50"
          >
            {focused ? "Show all" : "Focus mode"}
          </button>
        </div>
      </div>
      {focused ? (
        <>
          {current ? renderItem(current) : null}
          <p className="text-[11px] font-semibold text-slate-400">
            Use ← and → to move through the queue. Approving an item removes it, and the next one takes its place.
          </p>
        </>
      ) : (
        reviewItems.map(renderItem)
      )}
    </div>
  );
}

function InsightsTab({
  statementId,
  transactions,
  model,
  totals,
}: {
  statementId: string;
  transactions: AccountingTransaction[];
  model: Model;
  totals: { difference: number; reconciled: boolean };
}) {
  const duplicates = useMemo(() => detectDuplicates(transactions), [transactions]);
  const unusual = useMemo(() => detectUnusualTransactions(transactions), [transactions]);
  const directors = useMemo(() => detectDirectorTransactions(transactions), [transactions]);
  const large = useMemo(() => model.transactions.filter((t) => (t.debit || t.credit) >= 25000), [model.transactions]);
  const unresolved = useMemo(() => model.transactions.filter((t) => t.reviewReason), [model.transactions]);
  const vatReview = useMemo(() => model.transactions.filter((t) => t.vatCode === "REV"), [model.transactions]);

  const cards: Array<{ label: string; value: number }> = [
    { label: "Duplicate payment groups", value: duplicates.length },
    { label: "Unusual transactions", value: unusual.length },
    { label: "Related-party / director", value: directors.length },
    { label: "Large transactions", value: large.length },
    { label: "Unresolved review items", value: unresolved.length },
    { label: "VAT review items", value: vatReview.length },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-navy-950">Transaction Insights</h3>
        <a
          href={`/api/accounting/fnb/export/${statementId}?section=transaction-insights`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-royal-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-royal-700"
        >
          <Download className="h-4 w-4" /> Download Report
        </a>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className={`rounded-lg border p-2 text-center ${card.value ? "border-amber-200 bg-amber-50" : "border-slate-100 bg-slate-50"}`}>
            <p className={`text-base font-black ${card.value ? "text-amber-800" : "text-slate-400"}`}>{card.value}</p>
            <p className="text-[10px] font-bold text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>
      <div className={`rounded-lg border p-2 text-xs font-bold ${totals.reconciled ? "border-emerald-100 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
        {totals.reconciled ? "Reconciliation: balanced." : `Reconciliation: review required (off by ${fmtMoney(totals.difference)}).`}
      </div>
      {duplicates.length ? (
        <InsightList title="Possible duplicates" items={duplicates.map((d) => `${d.transactions[0]?.description ?? "—"} — ${fmtMoney(d.amount)} ×${d.transactions.length}`)} />
      ) : null}
      {unusual.length ? <InsightList title="Unusual transactions" items={unusual.map((u) => `${u.transaction.description} — ${u.reason}`)} /> : null}
      {directors.length ? <InsightList title="Related-party / director activity" items={directors.map((d) => `${d.transaction.description} — ${fmtMoney(d.transaction.debitAmount ?? d.transaction.creditAmount ?? 0)}`)} /> : null}
      {unresolved.length ? <InsightList title="Unresolved review items" items={unresolved.slice(0, 20).map((t) => `${t.description} — ${t.reviewReason}`)} /> : null}
      <p className="text-xs font-semibold text-slate-400">Review insights for the accountant. Download the report for the full breakdown.</p>
    </div>
  );
}

function InsightList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border border-slate-100 p-2">
      <p className="text-xs font-black uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="mt-1 space-y-0.5 text-xs font-semibold text-slate-600">
        {items.map((item, index) => (
          <li key={index} className="truncate" title={item}>• {item}</li>
        ))}
      </ul>
    </div>
  );
}

function DifferenceTab({ totals, model }: { totals: { opening: number; moneyIn: number; moneyOut: number; expectedClosing: number; closing: number; difference: number; reconciled: boolean }; model: Model }) {
  const missingCharges = model.transactions.some((t) => t.bankCharge) ? 0 : 1;
  return (
    <div className="space-y-3">
      <div className={`rounded-lg border p-3 ${totals.reconciled ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <p className={`text-sm font-black ${totals.reconciled ? "text-emerald-800" : "text-amber-800"}`}>
          {totals.reconciled ? "Statement reconciles." : "Reconciliation failed — figures may be incomplete."}
        </p>
      </div>
      <dl className="space-y-1.5 rounded-lg border border-slate-100 p-3 text-sm">
        <Row label="Expected Closing Balance" value={fmtMoney(totals.expectedClosing)} />
        <Row label="Actual Closing Balance" value={fmtMoney(totals.closing)} />
        <Row label="Difference" value={fmtMoney(totals.difference)} tone={totals.reconciled ? "good" : "warn"} />
      </dl>
      {!totals.reconciled ? (
        <div className="rounded-lg border border-slate-100 p-3">
          <p className="text-xs font-black uppercase tracking-wide text-slate-400">Likely causes</p>
          <ul className="mt-2 space-y-1 text-sm font-semibold text-slate-600">
            <li>• Missing rows not captured during extraction ({fmtMoney(Math.abs(totals.difference))} unaccounted)</li>
            <li>• Possible duplicate rows inflating a total</li>
            {missingCharges ? <li>• Bank charges / fees not captured on separate lines</li> : null}
            <li>• Skipped or unreadable rows in the PDF (image-only or noisy text)</li>
            <li>• Opening or closing balance mis-read from the statement</li>
          </ul>
          <p className="mt-2 text-xs font-semibold text-slate-400">Re-process the statement, or correct the affected rows in the Review tab, then regenerate the workbook.</p>
        </div>
      ) : null}
    </div>
  );
}

function SummaryTab({ run, model, totals, reviewCount }: { run: AccountingStatementRun; model: Model; totals: { moneyIn: number; moneyOut: number; charges: number; difference: number; reconciled: boolean }; reviewCount: number }) {
  const transfers = model.transactions.filter((t) => /transfer/i.test(t.category)).reduce((s, t) => s + (t.debit || t.credit), 0);
  return (
    <dl className="space-y-1.5 rounded-lg border border-slate-100 p-3 text-sm">
      <Row label="Transactions" value={String(run.transactionCount || model.transactions.length)} />
      <Row label="Income" value={fmtMoney(totals.moneyIn)} />
      <Row label="Expenses" value={fmtMoney(totals.moneyOut)} />
      <Row label="Transfers" value={fmtMoney(transfers)} />
      <Row label="Bank Charges" value={fmtMoney(totals.charges)} />
      <Row label="Output VAT" value={fmtMoney(model.vat201.outputVat)} />
      <Row label="Input VAT" value={fmtMoney(model.vat201.inputVat)} />
      <Row label="Net VAT" value={fmtMoney(model.vat201.netVat)} />
      <Row label="Cash Movement" value={fmtMoney(totals.moneyIn - totals.moneyOut)} tone={totals.moneyIn - totals.moneyOut >= 0 ? "good" : "warn"} />
      <Row label="Data Quality" value={totals.reconciled ? "Complete" : "Review Required"} tone={totals.reconciled ? "good" : "warn"} />
      <Row label="Reconciliation" value={totals.reconciled ? "Reconciled" : `Off by ${fmtMoney(totals.difference)}`} tone={totals.reconciled ? "good" : "warn"} />
      <Row label="Export Status" value={reviewCount ? "Review before export" : "Ready to export"} tone={reviewCount ? "warn" : "good"} />
    </dl>
  );
}

function ReconciliationTab({ totals }: { totals: { opening: number; moneyIn: number; moneyOut: number; charges: number; expectedClosing: number; closing: number; difference: number; reconciled: boolean } }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-slate-100 p-3 text-sm">
      <Row label="Opening Balance" value={fmtMoney(totals.opening)} />
      <Row label="+ Money In" value={fmtMoney(totals.moneyIn)} />
      <Row label="− Money Out" value={fmtMoney(totals.moneyOut)} />
      <Row label="  incl. Charges" value={fmtMoney(totals.charges)} />
      <div className="my-1 border-t border-slate-100" />
      <Row label="= Expected Closing" value={fmtMoney(totals.expectedClosing)} />
      <Row label="Actual Closing" value={fmtMoney(totals.closing)} />
      <Row label="Difference" value={fmtMoney(totals.difference)} tone={totals.reconciled ? "good" : "warn"} />
      <Row label="Status" value={totals.reconciled ? "Reconciled" : "Review Required"} tone={totals.reconciled ? "good" : "warn"} />
    </div>
  );
}

function VatTab({ model }: { model: Model }) {
  const v = model.vat201;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Output VAT" value={fmtMoney(v.outputVat)} />
        <Metric label="Input VAT" value={fmtMoney(v.inputVat)} />
        <Metric label="Net VAT" value={fmtMoney(v.netVat)} />
      </div>
      <div className="flex flex-wrap gap-2 text-xs font-bold">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">{v.reviewItems} review items</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{v.missingInvoices} missing invoices</span>
      </div>
      <div className="overflow-auto rounded-lg border border-slate-100">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-2 py-2 font-black">Date</th>
              <th className="px-2 py-2 font-black">Description</th>
              <th className="px-2 py-2 font-black">Code</th>
              <th className="px-2 py-2 text-right font-black">Input</th>
              <th className="px-2 py-2 text-right font-black">Output</th>
              <th className="px-2 py-2 font-black">Box</th>
            </tr>
          </thead>
          <tbody>
            {model.transactions.map((t) => (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">{fmtDate(t.date)}</td>
                <td className="max-w-[150px] truncate px-2 py-1.5 font-semibold text-navy-950" title={t.description}>{t.description}</td>
                <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${t.vatCode === "REV" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{t.vatCode}</span></td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-700">{t.inputVat ? fmtMoney(t.inputVat) : ""}</td>
                <td className="px-2 py-1.5 text-right font-bold text-emerald-700">{t.outputVat ? fmtMoney(t.outputVat) : ""}</td>
                <td className="px-2 py-1.5 font-semibold text-slate-500">{t.sarsBox}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LedgerTab({ model, opening }: { model: Model; opening: number }) {
  let balance = opening;
  return (
    <div className="overflow-auto rounded-lg border border-slate-100">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-2 py-2 font-black">Date</th>
            <th className="px-2 py-2 font-black">Reference</th>
            <th className="px-2 py-2 font-black">Account</th>
            <th className="px-2 py-2 text-right font-black">Debit</th>
            <th className="px-2 py-2 text-right font-black">Credit</th>
            <th className="px-2 py-2 text-right font-black">Balance</th>
          </tr>
        </thead>
        <tbody>
          {model.transactions.map((t) => {
            balance += t.credit - t.debit;
            return (
              <tr key={t.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">{fmtDate(t.date)}</td>
                <td className="max-w-[80px] truncate px-2 py-1.5 font-semibold text-slate-500">{t.reference}</td>
                <td className="max-w-[130px] truncate px-2 py-1.5 font-semibold text-navy-950" title={t.account.name}>{t.account.name}</td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-700">{t.debit ? fmtMoney(t.debit) : ""}</td>
                <td className="px-2 py-1.5 text-right font-bold text-emerald-700">{t.credit ? fmtMoney(t.credit) : ""}</td>
                <td className="px-2 py-1.5 text-right font-semibold text-slate-600">{fmtMoney(balance)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrialBalanceTab({ model, reconciled }: { model: Model; reconciled: boolean }) {
  const tb = model.trialBalance;
  return (
    <div className="space-y-2">
      {!reconciled ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs font-bold text-amber-800">REVIEW REQUIRED — statement does not reconcile.</div> : null}
      <div className="overflow-auto rounded-lg border border-slate-100">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-2 py-2 font-black">Account</th>
              <th className="px-2 py-2 text-right font-black">Debit</th>
              <th className="px-2 py-2 text-right font-black">Credit</th>
              <th className="px-2 py-2 font-black">Status</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.number} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-semibold text-navy-950">{r.name}</td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-700">{r.debit ? fmtMoney(r.debit) : ""}</td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-700">{r.credit ? fmtMoney(r.credit) : ""}</td>
                <td className="px-2 py-1.5"><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black ${reconciled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{reconciled ? "OK" : "Review"}</span></td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-black">
              <td className="px-2 py-1.5 text-navy-950">Totals</td>
              <td className="px-2 py-1.5 text-right text-navy-950">{fmtMoney(tb.totalDebit)}</td>
              <td className="px-2 py-1.5 text-right text-navy-950">{fmtMoney(tb.totalCredit)}</td>
              <td className="px-2 py-1.5 text-xs">{reconciled ? (tb.balanced ? "Balanced" : "Out of balance") : "Review Required"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-center">
      <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-black text-navy-950">{value}</p>
    </div>
  );
}

// ── Bottom quick-review cards ─────────────────────────────────────────────────

function QuickReview({ model, transactions, totals, onOpenReview }: { model: Model; transactions: AccountingTransaction[]; totals: { charges: number }; onOpenReview: () => void }) {
  const key = (t: AccountingTransaction) => `${t.transactionDate}|${t.debitAmount ?? ""}|${t.creditAmount ?? ""}`;
  const seen = new Map<string, number>();
  transactions.forEach((t) => seen.set(key(t), (seen.get(key(t)) ?? 0) + 1));
  const duplicates = Array.from(seen.values()).filter((n) => n > 1).length;
  const missingVat = model.transactions.filter((t) => t.vatCode === "REV").length;
  const unresolved = model.transactions.filter((t) => t.reviewReason).length;
  const large = model.transactions.filter((t) => (t.debit || t.credit) >= 25000).length;
  const relatedParty = model.transactions.filter((t) => /related party|drawings/i.test(t.category)).length;
  const director = model.transactions.filter((t) => /director/i.test(t.category)).length;

  const cards: Array<{ label: string; value: number; warn: boolean }> = [
    { label: "Possible duplicates", value: duplicates, warn: duplicates > 0 },
    { label: "Missing VAT", value: missingVat, warn: missingVat > 0 },
    { label: "Unresolved items", value: unresolved, warn: unresolved > 0 },
    { label: "Large transactions", value: large, warn: large > 0 },
    { label: "Related-party payments", value: relatedParty, warn: relatedParty > 0 },
    { label: "Director payments", value: director, warn: director > 0 },
  ];

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-black text-navy-950">Quick Review</h2>
        <button onClick={onOpenReview} className="text-xs font-bold text-royal-700 hover:text-royal-800">Open Review Queue →</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((card) => (
          <button
            key={card.label}
            onClick={onOpenReview}
            className={`rounded-xl border p-3 text-left transition hover:shadow-sm ${card.warn ? "border-amber-200 bg-amber-50" : "border-slate-100 bg-slate-50"}`}
          >
            <p className={`text-lg font-black ${card.warn ? "text-amber-800" : "text-slate-500"}`}>{card.value}</p>
            <p className="text-[11px] font-bold text-slate-500">{card.label}</p>
          </button>
        ))}
      </div>
      {totals.charges === 0 ? <p className="mt-2 text-xs font-bold text-amber-700">No bank charges detected — confirm the statement has no fees.</p> : null}
    </section>
  );
}

// ── Notes panel (persisted locally per statement) ─────────────────────────────

type NotesState = { accountant: string; client: string; internal: string };
type NoteHistory = { at: string; summary: string };

function NotesPanel({ statementId }: { statementId: string }) {
  const storageKey = `docucorex.statement-notes.${statementId}`;
  const [notes, setNotes] = useState<NotesState>({ accountant: "", client: "", internal: "" });
  const [history, setHistory] = useState<NoteHistory[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { notes?: NotesState; history?: NoteHistory[] };
        if (parsed.notes) setNotes(parsed.notes);
        if (parsed.history) setHistory(parsed.history);
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  function save() {
    const entry: NoteHistory = {
      at: new Date().toISOString(),
      summary: `Saved notes (${[notes.accountant && "accountant", notes.client && "client", notes.internal && "internal"].filter(Boolean).join(", ") || "empty"})`,
    };
    const nextHistory = [entry, ...history].slice(0, 10);
    setHistory(nextHistory);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ notes, history: nextHistory }));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-black text-navy-950">Notes</h2>
        <button onClick={save} className="rounded-lg bg-royal-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-royal-700">
          {saved ? "Saved" : "Save Notes"}
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {(["accountant", "client", "internal"] as const).map((field) => (
          <label key={field} className="block">
            <span className="text-xs font-black uppercase tracking-wide text-slate-400">{field} Notes</span>
            <textarea
              value={notes[field]}
              onChange={(e) => setNotes((n) => ({ ...n, [field]: e.target.value }))}
              rows={4}
              className="mt-1 w-full resize-y rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-royal-300"
              placeholder={`${field[0].toUpperCase()}${field.slice(1)} notes…`}
            />
          </label>
        ))}
      </div>
      {history.length ? (
        <div className="mt-3">
          <p className="text-xs font-black uppercase tracking-wide text-slate-400">History</p>
          <ul className="mt-1 space-y-1 text-xs font-semibold text-slate-500">
            {history.map((entry, index) => (
              <li key={index}>• {new Date(entry.at).toLocaleString("en-ZA")} — {entry.summary}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

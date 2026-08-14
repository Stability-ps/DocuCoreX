"use client";

/**
 * Accounting Overview.
 *
 * The question this page answers is the specification's: are the records
 * complete, reconciled, and ready for reporting?
 *
 * What it deliberately does NOT show is as important as what it does. An
 * accounting overview normally leads with Cash & Bank, Trade Receivables, Trade
 * Payables, Net Profit and VAT Payable. Every one of those is a LEDGER balance,
 * and this product has no ledger yet — general ledger and trial balance are
 * derived in memory at export time from bank-statement rows (see
 * docs/ACCOUNTING_WORKSPACE_PLAN.md §1.3). A card reading "Trade Receivables
 * R0" would not be an empty state; it would be a false statement about a
 * client's books, on the screen an accountant trusts most.
 *
 * So this shows only what the system can actually stand behind today: the
 * statements it holds, what it extracted from them, what still needs review,
 * and where the coverage gaps are. Ledger metrics arrive with the ledger.
 *
 * Every figure here is fetched from an existing endpoint. Nothing is computed
 * from a constant, and nothing is estimated.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  FileSpreadsheet,
  Landmark,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { AccountingStatementRun } from "@/lib/accounting/types";
import { formatMoney } from "@/lib/accounting/format";

type CoverageSummary = {
  coveragePercent: number;
  missing: Array<{ accountLabel: string; month: string }>;
  accountsTracked: number;
  statementsReceived: number;
  statementsReconciled: number;
  engagementInferred: boolean;
};

type OverviewState = {
  runs: AccountingStatementRun[];
  coverage: CoverageSummary | null;
  reviewQueueCount: number;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-02" → "Feb 2026". Display only; the stored value stays ISO. */
function monthLabel(month: string): string {
  const [year, index] = month.split("-");
  const name = MONTH_LABELS[Number(index) - 1];
  return name ? `${name} ${year}` : month;
}

/** "2026-02-28" → "28 Feb 2026", the South African convention. */
function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const [year, month, day] = iso.split("-");
  const name = MONTH_LABELS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

export function AccountingOverview() {
  const [state, setState] = useState<OverviewState>({ runs: [], coverage: null, reviewQueueCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    // Settled rather than all: coverage needs an engagement and the review queue
    // needs the engine tables. One being unavailable should not blank the whole
    // page — the parts that did load are still true.
    const [runsResult, coverageResult, reviewResult] = await Promise.allSettled([
      fetch("/api/accounting/fnb/runs").then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status))))),
      fetch("/api/accounting/coverage").then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status))))),
      fetch("/api/accounting/engine/review-queue?status=needs_review").then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status))))),
    ]);

    if (runsResult.status === "rejected") {
      setError("Unable to load statements. Refresh to try again.");
      setLoading(false);
      return;
    }

    // /api/accounting/coverage responds { coverage, engagement } — not the
    // coverage summary directly. Assigning the whole body here silently made
    // `coverage` an object without a `missing` array, and every `coverage.missing.length`
    // read below threw "Cannot read properties of undefined" once this endpoint
    // actually returned data.
    setState({
      runs: (runsResult.value?.runs ?? []) as AccountingStatementRun[],
      coverage:
        coverageResult.status === "fulfilled"
          ? ((coverageResult.value as { coverage?: CoverageSummary })?.coverage ?? null)
          : null,
      reviewQueueCount:
        reviewResult.status === "fulfilled" && Array.isArray(reviewResult.value?.items) ? reviewResult.value.items.length : 0,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { runs, coverage, reviewQueueCount } = state;
  const transactionCount = runs.reduce((total, run) => total + (run.transactionCount ?? 0), 0);
  const statementsNeedingReview = runs.filter((run) => run.reviewRequired).length;
  const unreconciled = runs.filter(
    (run) => run.reconciliationDifference !== null && run.reconciliationDifference !== undefined && Math.abs(run.reconciliationDifference) > 0.005,
  ).length;
  const latest = runs.find((run) => run.statementPeriodEnd) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading accounting overview…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm font-semibold text-red-800">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  if (!runs.length) {
    return <EmptyOverview />;
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="readiness-heading">
        <h2 id="readiness-heading" className="sr-only">
          Books readiness
        </h2>
        <ReadinessPanel
          statements={runs.length}
          statementsNeedingReview={statementsNeedingReview}
          unreconciled={unreconciled}
          reviewQueueCount={reviewQueueCount}
          coverage={coverage}
        />
      </section>

      <section aria-labelledby="metrics-heading" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <h2 id="metrics-heading" className="sr-only">
          Statement metrics
        </h2>
        <MetricCard
          icon={Landmark}
          label="Statements processed"
          value={String(runs.length)}
          detail={coverage ? `${coverage.accountsTracked} bank ${coverage.accountsTracked === 1 ? "account" : "accounts"}` : undefined}
          href="/accounting/bank-statements"
          linkLabel="View statements"
        />
        <MetricCard
          icon={FileSpreadsheet}
          label="Transactions extracted"
          value={transactionCount.toLocaleString("en-ZA")}
          detail="Across all processed statements"
          href="/accounting/bank-statements"
          linkLabel="View transactions"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Requiring review"
          value={String(reviewQueueCount)}
          detail={statementsNeedingReview ? `${statementsNeedingReview} ${statementsNeedingReview === 1 ? "statement" : "statements"} flagged` : "No statements flagged"}
          href="/accounting/bank-statements"
          linkLabel="Open review queue"
          tone={reviewQueueCount > 0 ? "warn" : "ok"}
        />
        <MetricCard
          icon={CalendarClock}
          label="Statement coverage"
          value={coverage ? `${Math.round(coverage.coveragePercent)}%` : "—"}
          detail={
            coverage
              ? coverage.missing.length
                ? `${coverage.missing.length} account-${coverage.missing.length === 1 ? "month" : "months"} missing`
                : "No gaps detected"
              : "Coverage unavailable"
          }
          href="/accounting/audit-tools"
          linkLabel="View coverage"
          tone={coverage && coverage.missing.length ? "warn" : "ok"}
        />
      </section>

      {latest ? (
        <section
          aria-labelledby="latest-heading"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2 id="latest-heading" className="text-sm font-bold text-navy-950">
            Most recent statement
          </h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Account" value={latest.accountNumber ?? latest.bank ?? "Unknown"} />
            <Field label="Period end" value={dateLabel(latest.statementPeriodEnd) ?? "—"} />
            <Field label="Transactions" value={String(latest.transactionCount ?? 0)} />
            <Field
              label="Closing balance per statement"
              value={latest.closingBalance === null || latest.closingBalance === undefined ? "—" : formatMoney(latest.closingBalance)}
              numeric
            />
          </dl>
          {/* Named precisely: this is the balance the BANK printed, not a ledger
              balance. The distinction stops mattering only once postings exist. */}
        </section>
      ) : null}

      {coverage?.engagementInferred ? (
        <p className="text-xs font-semibold text-slate-500">
          The reporting window is inferred from the statements on hand, so only gaps between held statements are reported.{" "}
          <Link href="/accounting/audit-tools" className="text-royal-700 underline">
            Set the engagement period
          </Link>{" "}
          to detect statements missing before or after them.
        </p>
      ) : null}
    </div>
  );
}

function ReadinessPanel({
  statements,
  statementsNeedingReview,
  unreconciled,
  reviewQueueCount,
  coverage,
}: {
  statements: number;
  statementsNeedingReview: number;
  unreconciled: number;
  reviewQueueCount: number;
  coverage: CoverageSummary | null;
}) {
  // Only checks the system can actually evaluate today. A check that cannot be
  // evaluated is absent rather than shown as passing — a green tick nobody
  // computed is worse than no tick at all.
  const checks: Array<{ label: string; state: "ok" | "warn"; href: string }> = [
    {
      label: statements ? `${statements} ${statements === 1 ? "statement" : "statements"} processed` : "No statements processed",
      state: statements ? "ok" : "warn",
      href: "/accounting/bank-statements",
    },
    {
      label: unreconciled ? `${unreconciled} ${unreconciled === 1 ? "statement does" : "statements do"} not reconcile` : "All statements reconcile to their printed closing balance",
      state: unreconciled ? "warn" : "ok",
      href: "/accounting/bank-statements",
    },
    {
      label: reviewQueueCount ? `${reviewQueueCount} ${reviewQueueCount === 1 ? "transaction requires" : "transactions require"} review` : "No transactions awaiting review",
      state: reviewQueueCount ? "warn" : "ok",
      href: "/accounting/bank-statements",
    },
    {
      label: statementsNeedingReview ? `${statementsNeedingReview} ${statementsNeedingReview === 1 ? "statement is" : "statements are"} flagged for review` : "No statements flagged for review",
      state: statementsNeedingReview ? "warn" : "ok",
      href: "/accounting/bank-statements",
    },
  ];

  if (coverage) {
    checks.push({
      label: coverage.missing.length
        ? `${coverage.missing.length} account-${coverage.missing.length === 1 ? "month" : "months"} missing (${coverage.missing.slice(0, 2).map((gap) => monthLabel(gap.month)).join(", ")}${coverage.missing.length > 2 ? "…" : ""})`
        : "Statement coverage complete for the period held",
      state: coverage.missing.length ? "warn" : "ok",
      href: "/accounting/audit-tools",
    });
  }

  const passed = checks.filter((check) => check.state === "ok").length;
  const percent = Math.round((passed / checks.length) * 100);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Books readiness</h3>
        <p className="text-2xl font-semibold tabular-nums text-navy-950">
          {percent}%
          <span className="ml-2 text-sm font-semibold text-slate-500">
            {passed} of {checks.length} checks passed
          </span>
        </p>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Books readiness"
      >
        <div className="h-full rounded-full bg-royal-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <ul className="mt-4 space-y-1">
        {checks.map((check) => (
          <li key={check.label}>
            <Link
              href={check.href}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              {/* Shape as well as colour, so the status does not depend on
                  colour perception alone. */}
              {check.state === "ok" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              )}
              <span className="sr-only">{check.state === "ok" ? "Passed:" : "Needs attention:"}</span>
              <span className="min-w-0 flex-1">{check.label}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition group-hover:text-royal-600" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-500">
        Checks cover the statements held. Trial balance, reconciliation and year-end checks join this list once the
        accounting ledger is in place.
      </p>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  href,
  linkLabel,
  tone = "neutral",
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
  detail?: string;
  href: string;
  linkLabel: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-royal-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-royal-500"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
        <Icon
          className={`h-4 w-4 shrink-0 ${tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-emerald-600" : "text-slate-300"}`}
          aria-hidden="true"
        />
      </div>
      <p className="text-2xl font-semibold tabular-nums text-navy-950">{value}</p>
      <div>
        {detail ? <p className="text-xs font-semibold text-slate-500">{detail}</p> : null}
        <p className="mt-1 flex items-center gap-1 text-xs font-bold text-royal-700">
          {linkLabel}
          <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" aria-hidden="true" />
        </p>
      </div>
    </Link>
  );
}

function Field({ label, value, numeric = false }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-sm font-semibold text-navy-950 ${numeric ? "tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function EmptyOverview() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <CircleDashed className="mx-auto h-10 w-10 text-slate-300" aria-hidden="true" />
      <h2 className="mt-4 text-base font-bold text-navy-950">No accounting records yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm font-semibold text-slate-500">
        Accounting starts from a bank statement. Upload one and DocuCoreX extracts its transactions, validates them
        against the statement&apos;s own opening and closing balances, and puts anything uncertain in a review queue.
      </p>
      <Link
        href="/accounting/bank-statements"
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-royal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-royal-700"
      >
        Upload a bank statement
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

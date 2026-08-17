"use client";

/**
 * Trial Balance.
 *
 * Aggregated from accounting_postings by the database. Nothing here reads a
 * bank statement, a transaction category or an extraction.
 *
 * Two rules the display must not soften:
 *
 *   - BALANCED means exactly balanced. The verdict comes from cent arithmetic,
 *     never from a rounded display value, so a one-cent difference can never be
 *     presented as balanced.
 *   - An account with no postings is absent, not zero. A trial balance listing
 *     every account in the chart at R0.00 would state that the period was
 *     examined and found empty, which is a different claim from "nothing has
 *     been posted".
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import type { AccountingEntity } from "@/lib/accounting/chart";
import { ACCOUNT_TYPE_LABELS } from "@/lib/accounting/chart";
import {
  trialBalanceTotals,
  type TrialBalanceRow,
} from "@/lib/accounting/ledger";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

export function TrialBalance() {
  const period = useEntityPeriod();
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [includeAdjustments, setIncludeAdjustments] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (companyId: string, from: string, to: string, adjustments: boolean) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ companyId, from, to, includeAdjustments: String(adjustments) });
      const response = await fetch(`/api/accounting/trial-balance?${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load the trial balance.");
      setRows(data.rows ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the trial balance.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId) void load(period.companyId, period.from, period.to, includeAdjustments);
  }, [period.companyId, period.from, period.to, includeAdjustments, load]);

  // Recomputed here rather than trusted from the response, so what the verdict
  // asserts and what the table shows are the same arithmetic.
  const totals = trialBalanceTotals(rows);

  const exportHref = period.companyId
    ? `/api/accounting/trial-balance?${new URLSearchParams({
        companyId: period.companyId,
        from: period.from,
        to: period.to,
        includeAdjustments: String(includeAdjustments),
        format: "csv",
      })}`
    : "#";

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
              <input
                type="checkbox"
                checked={!includeAdjustments}
                onChange={(event) => setIncludeAdjustments(!event.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Unadjusted
            </label>
            {rows.length ? (
              <a
                href={exportHref}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Export CSV
              </a>
            ) : null}
          </div>
        }
      />

      {period.loading || (loading && period.companyId) ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading trial balance…
        </div>
      ) : !period.companyId ? (
        // period.companyId never resolved: the entity list failed to load (period.error)
        // or the workspace has none. load() only ever runs once companyId is set, so
        // without this branch `loading` stayed true forever and this stage was
        // unreachable — the page just spun.
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-800">{period.error || "No accounting entities are set up for this workspace yet."}</p>
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-800">{error}</p>
          <button
            type="button"
            onClick={() => period.companyId && void load(period.companyId, period.from, period.to, includeAdjustments)}
            className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : !rows.length ? (
        <EmptyTrialBalance />
      ) : (
        <>
          <div
            className={`rounded-2xl border p-5 shadow-sm ${
              totals.balanced ? "border-emerald-200 bg-emerald-50/50" : "border-amber-300 bg-amber-50"
            }`}
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <dl className="flex flex-wrap gap-x-10 gap-y-2">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Total debits</dt>
                  <dd className="text-lg font-semibold tabular-nums text-navy-950">{formatLedgerMoney(totals.totalDebits)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Total credits</dt>
                  <dd className="text-lg font-semibold tabular-nums text-navy-950">{formatLedgerMoney(totals.totalCredits)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Difference</dt>
                  <dd className={`text-lg font-semibold tabular-nums ${totals.balanced ? "text-navy-950" : "text-amber-800"}`}>
                    {formatLedgerMoney(totals.difference)}
                  </dd>
                </div>
              </dl>
              <p
                className={`flex items-center gap-2 text-sm font-black uppercase tracking-wide ${
                  totals.balanced ? "text-emerald-700" : "text-amber-800"
                }`}
              >
                {totals.balanced ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                )}
                {totals.balanced ? "Balanced" : "Out of balance"}
              </p>
            </div>
            {!totals.balanced ? (
              <p className="mt-3 border-t border-amber-200 pt-3 text-sm font-semibold text-amber-900">
                A trial balance that does not balance is not a valid trial balance. Financial statements must not be
                prepared from it until the difference is found.
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-sm">
                <caption className="sr-only">
                  Trial balance for {period.entity?.name ?? "the selected entity"}, {period.from} to {period.to}
                </caption>
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="border-b border-slate-200 text-left">
                    <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Code</th>
                    <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Debits</th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Credits</th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Closing</th>
                    <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Prior year</th>
                    <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">AFS mapping</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.accountId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-semibold tabular-nums text-navy-950">{row.code}</td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/accounting/general-ledger?companyId=${period.companyId}&accountId=${row.accountId}&from=${period.from}&to=${period.to}`}
                          className="font-medium text-royal-700 hover:underline"
                        >
                          {row.name}
                        </Link>
                        <span className="ml-2 text-xs font-semibold text-slate-400">
                          {ACCOUNT_TYPE_LABELS[row.accountType as keyof typeof ACCOUNT_TYPE_LABELS] ?? row.accountType}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.debits, { blankZero: true })}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.credits, { blankZero: true })}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums text-navy-950">{formatLedgerMoney(row.closingBalance)}</td>
                      {/* Not fabricated. Comparatives need prior-year ledger or
                          opening balances, and AFS mapping is Stage 11. A zero
                          here would be a claim that last year was nil. */}
                      <td className="px-4 py-2 text-xs font-semibold text-slate-400">Not imported</td>
                      <td className="px-4 py-2 text-xs font-semibold text-slate-400">Not mapped</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                    <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-slate-500" colSpan={2}>Total</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-navy-950">{formatLedgerMoney(totals.totalDebits)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-navy-950">{formatLedgerMoney(totals.totalCredits)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <p className="text-xs font-semibold text-slate-500">
            Prior year and AFS mapping are shown as not yet available rather than as zero. Comparatives require
            prior-year ledger or imported opening balances; financial-statement mapping arrives with the reporting
            stage.
          </p>
        </>
      )}
    </div>
  );
}

function EmptyTrialBalance() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <h2 className="text-base font-bold text-navy-950">No trial balance is available yet</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm font-semibold text-slate-500">
        A trial balance is generated from posted ledger entries. Once journals are posted for this entity and period,
        balances appear here.
      </p>
      <Link
        href="/accounting/journals"
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-royal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-royal-700"
      >
        View Journals
      </Link>
    </div>
  );
}

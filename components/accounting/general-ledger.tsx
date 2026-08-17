"use client";

/**
 * General Ledger.
 *
 * Every row is a posting. The page is fetched from the database already
 * carrying its running balance, so the browser never holds the whole ledger —
 * an entity with a million postings pages exactly as fast as one with fifty.
 *
 * Drill-down goes the way the specification requires: a ledger line names its
 * journal, and a line that came from a bank statement names its source
 * transaction. Nothing is copied to make that work; both are references.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, FileText, Loader2, RefreshCw, Search } from "lucide-react";
import type { LedgerAccount } from "@/lib/accounting/chart";
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_ORDER } from "@/lib/accounting/chart";
import {
  JOURNAL_TYPE_LABELS,
  formatLedgerDate,
  type LedgerRow,
} from "@/lib/accounting/ledger";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

const PAGE_SIZE = 100;

export function GeneralLedger({ initialAccountId }: { initialAccountId?: string }) {
  const period = useEntityPeriod();
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [openingBalance, setOpeningBalance] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [accountId, setAccountId] = useState(initialAccountId ?? "");
  const [accountType, setAccountType] = useState("");
  const [journalType, setJournalType] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const query = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({
        companyId: period.companyId,
        from: period.from,
        to: period.to,
        ...(accountId ? { accountId } : {}),
        ...(accountType ? { accountType } : {}),
        ...(journalType ? { journalType } : {}),
        ...(search ? { search } : {}),
        ...extra,
      }).toString(),
    [period.companyId, period.from, period.to, accountId, accountType, journalType, search],
  );

  const load = useCallback(async () => {
    if (!period.companyId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/accounting/general-ledger?${query({ limit: String(PAGE_SIZE), offset: String(offset) })}`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load the general ledger.");
      setRows(data.rows ?? []);
      setTotalRows(data.totalRows ?? 0);
      setOpeningBalance(data.openingBalance ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the general ledger.");
    } finally {
      setLoading(false);
    }
  }, [period.companyId, query, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!period.companyId) return;
    void (async () => {
      const response = await fetch(`/api/accounting/chart-of-accounts?companyId=${encodeURIComponent(period.companyId)}`);
      const data = await response.json();
      if (response.ok) setAccounts(data.accounts ?? []);
    })();
  }, [period.companyId]);

  // Any filter change invalidates the current page position.
  useEffect(() => {
    setOffset(0);
  }, [accountId, accountType, journalType, search, period.companyId, period.from, period.to]);

  const selectedAccount = accounts.find((account) => account.id === accountId) ?? null;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(Math.ceil(totalRows / PAGE_SIZE), 1);

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          rows.length ? (
            <a
              href={`/api/accounting/general-ledger?${query({ format: "csv" })}`}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export CSV
            </a>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <Filter label="Account" htmlFor="gl-account">
          <select
            id="gl-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="min-w-[14rem] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="Account type" htmlFor="gl-type">
          <select
            id="gl-type"
            value={accountType}
            onChange={(event) => setAccountType(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            <option value="">All types</option>
            {ACCOUNT_TYPE_ORDER.map((type) => (
              <option key={type} value={type}>{ACCOUNT_TYPE_LABELS[type]}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Journal type" htmlFor="gl-journal">
          <select
            id="gl-journal"
            value={journalType}
            onChange={(event) => setJournalType(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            <option value="">All journals</option>
            {Object.entries(JOURNAL_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Search" htmlFor="gl-search">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              id="gl-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Reference, account or description"
              className="w-56 rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm text-navy-950 placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            />
          </div>
        </Filter>
      </div>

      {period.loading || (loading && period.companyId) ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading general ledger…
        </div>
      ) : !period.companyId ? (
        // period.companyId never resolved: load() returns immediately without
        // touching `loading` when there is no companyId, so without this branch
        // `loading` stayed true forever and this stage was unreachable.
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-800">{period.error || "No accounting entities are set up for this workspace yet."}</p>
        </div>
      ) : error ? (
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
      ) : !rows.length ? (
        <EmptyLedger />
      ) : (
        <>
          {selectedAccount && openingBalance !== null ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
              <h2 className="text-sm font-bold text-navy-950">
                {selectedAccount.code} — {selectedAccount.name}
              </h2>
              <p className="text-sm font-semibold text-slate-500">
                Opening balance{" "}
                <span className="tabular-nums text-navy-950">{formatLedgerMoney(openingBalance)}</span>
              </p>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[60rem] border-collapse text-sm">
                <caption className="sr-only">
                  General ledger for {period.entity?.name ?? "the selected entity"}, {period.from} to {period.to}
                </caption>
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="border-b border-slate-200 text-left">
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Reference</th>
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Journal</th>
                    <th scope="col" className="px-3 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Debit</th>
                    <th scope="col" className="px-3 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Credit</th>
                    <th scope="col" className="px-3 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Balance</th>
                    <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.postingId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-navy-950">{formatLedgerDate(row.postingDate)}</td>
                      <td className="px-3 py-2 font-semibold text-navy-950">{row.journalReference ?? "—"}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setAccountId(row.accountId)}
                          className="text-left font-medium text-royal-700 hover:underline"
                        >
                          {row.accountCode} — {row.accountName}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{row.description ?? "—"}</td>
                      <td className="px-3 py-2 text-xs font-semibold text-slate-500">
                        {JOURNAL_TYPE_LABELS[row.journalType] ?? row.journalType}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.debit, { blankZero: true })}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.credit, { blankZero: true })}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-navy-950">{formatLedgerMoney(row.runningBalance)}</td>
                      <td className="px-3 py-2">
                        {row.sourceRunId ? (
                          // The end of the chain: this opens the statement the
                          // figure came from. A reference, not a copy.
                          <Link
                            href={`/accounting/statements/${row.sourceRunId}`}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-royal-700 hover:underline"
                            title="Open the bank statement this entry came from"
                          >
                            <FileText className="h-3 w-3" aria-hidden="true" />
                            Statement
                          </Link>
                        ) : row.sourceTransactionId ? (
                          // Linked to a transaction whose statement has since
                          // been removed. The ledger entry stands; the evidence
                          // no longer does, and saying so is the honest state.
                          <span className="text-xs font-semibold text-slate-400" title="Source statement no longer available">
                            Source removed
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-slate-400">Journal</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold text-slate-500">
              {totalRows.toLocaleString("en-ZA")} {totalRows === 1 ? "entry" : "entries"} · page {page} of {pages}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
                disabled={offset === 0}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Previous
              </button>
              <button
                type="button"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= totalRows}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Filter({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-bold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function EmptyLedger() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <h2 className="text-base font-bold text-navy-950">No ledger entries for this period</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm font-semibold text-slate-500">
        The General Ledger contains posted accounting entries. Create or post a journal, and its entries appear here.
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

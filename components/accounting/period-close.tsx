"use client";

/**
 * Period Close.
 *
 * Closing and reopening are both delegated to the database
 * (accounting_close_period / accounting_reopen_period, migration 041). This
 * screen shows the readiness numbers those functions would themselves check —
 * unposted journals, open reconciliations, VAT period status — so a refusal is
 * expected before the round trip, not a surprise after it.
 *
 * "Absence of a row means open": a period only appears in the table below once
 * someone has closed it. There is no row for an open period to select.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Lock, LockOpen, Loader2, ShieldAlert } from "lucide-react";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import {
  PERIOD_STATUS_LABELS,
  lockBlockedReason,
  readinessNotes,
  type AccountingPeriod,
  type PeriodReadiness,
  type PeriodStatus,
} from "@/lib/accounting/period-close";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

async function postJson(body: Record<string, unknown>) {
  const response = await fetch("/api/accounting/periods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ?? "Request failed.");
  return data;
}

export function PeriodClose() {
  const period = useEntityPeriod();
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<PeriodStatus>("soft_closed");
  const [note, setNote] = useState("");
  const [readiness, setReadiness] = useState<PeriodReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [reopenTarget, setReopenTarget] = useState<AccountingPeriod | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);

  const load = useCallback(async (companyId: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/accounting/periods?companyId=${encodeURIComponent(companyId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load periods.");
      setPeriods(data.periods ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load periods.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId) void load(period.companyId);
  }, [period.companyId, load]);

  useEffect(() => {
    if (!period.companyId || !from || !to || from > to) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    (async () => {
      try {
        const response = await fetch(
          `/api/accounting/periods?companyId=${encodeURIComponent(period.companyId)}&view=readiness&from=${from}&to=${to}`,
        );
        const data = await response.json();
        if (!cancelled && response.ok) {
          setReadiness({
            unpostedJournalCount: data.unposted_journal_count ?? 0,
            openReconciliationCount: data.open_reconciliation_count ?? 0,
            vatPeriodStatus: data.vat_period_status ?? null,
          });
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period.companyId, from, to]);

  const blocked = status === "locked" && readiness ? lockBlockedReason(readiness) : null;
  const notes = readiness ? readinessNotes(readiness) : [];

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await postJson({ action: "close", companyId: period.companyId, from, to, status, note: note || null });
      setFrom("");
      setTo("");
      setNote("");
      setReadiness(null);
      await load(period.companyId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to close the period.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitReopen = async () => {
    if (!reopenTarget) return;
    setReopening(true);
    setError("");
    try {
      await postJson({ action: "reopen", periodId: reopenTarget.id, reason: reopenReason });
      setReopenTarget(null);
      setReopenReason("");
      await load(period.companyId);
    } catch (reopenError) {
      setError(reopenError instanceof Error ? reopenError.message : "Unable to reopen the period.");
    } finally {
      setReopening(false);
    }
  };

  return (
    <div className="space-y-4">
      <EntityPeriodBar {...period} />

      {error ? (
        <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Close a period</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="close-from" className="block text-xs font-bold uppercase tracking-wide text-slate-500">From</label>
            <input
              id="close-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            />
          </div>
          <div>
            <label htmlFor="close-to" className="block text-xs font-bold uppercase tracking-wide text-slate-500">To</label>
            <input
              id="close-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            />
          </div>
          <div>
            <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Status</span>
            <div className="mt-1 flex gap-1 rounded-lg border border-slate-300 p-1">
              {(["soft_closed", "locked"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatus(value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${
                    status === value ? "bg-navy-950 text-white" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {PERIOD_STATUS_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <div className="min-w-[14rem] flex-1">
            <label htmlFor="close-note" className="block text-xs font-bold uppercase tracking-wide text-slate-500">Note (optional)</label>
            <input
              id="close-note"
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Month-end close, signed off by…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            />
          </div>
        </div>

        {from && to ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            {checking ? (
              <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking readiness…</p>
            ) : readiness ? (
              <div className="space-y-1">
                {blocked ? (
                  <p className="flex items-center gap-2 font-semibold text-red-700">
                    <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> {blocked}
                  </p>
                ) : readiness.unpostedJournalCount > 0 ? (
                  <p className="text-slate-600">
                    {readiness.unpostedJournalCount} unposted journal{readiness.unpostedJournalCount === 1 ? "" : "s"} dated in this range — fine for a soft close, would block a lock.
                  </p>
                ) : (
                  <p className="font-semibold text-emerald-700">No unposted journals dated in this range.</p>
                )}
                {notes.map((line) => (
                  <p key={line} className="text-slate-500">{line}</p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={!from || !to || from > to || submitting || Boolean(blocked)}
          onClick={() => void submit()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-navy-950 px-4 text-sm font-semibold text-white transition hover:bg-navy-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
          {status === "locked" ? "Lock period" : "Soft-close period"}
        </button>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Closed periods</h2>
        </div>
        {loading ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Loading…</p>
        ) : !periods.length ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
            Every period is open. Nothing has been closed for this entity yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <caption className="sr-only">Closed accounting periods</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Period</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Note</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Closed</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {periods.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2 font-semibold text-navy-950">
                      {formatLedgerDate(row.periodStart)} – {formatLedgerDate(row.periodEnd)}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${
                          row.status === "locked" ? "bg-navy-950 text-white" : "border border-amber-200 bg-amber-50 text-amber-700"
                        }`}
                      >
                        {PERIOD_STATUS_LABELS[row.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{row.note ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{formatLedgerDate(row.closedAt.slice(0, 10))}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setReopenTarget(row)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50"
                      >
                        <LockOpen className="h-3 w-3" aria-hidden="true" />
                        Reopen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {reopenTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-sm font-bold text-navy-950">
              Reopen {formatLedgerDate(reopenTarget.periodStart)} – {formatLedgerDate(reopenTarget.periodEnd)}?
            </h3>
            <p className="text-sm text-slate-600">
              This is a deliberate, audited act — it will be recorded in the audit trail with the reason below.
            </p>
            <div>
              <label htmlFor="reopen-reason" className="block text-xs font-bold uppercase tracking-wide text-slate-500">Reason</label>
              <textarea
                id="reopen-reason"
                value={reopenReason}
                onChange={(event) => setReopenReason(event.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
                placeholder="Why does this period need to reopen?"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReopenTarget(null);
                  setReopenReason("");
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!reopenReason.trim() || reopening}
                onClick={() => void submitReopen()}
                className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reopening ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Reopen period
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

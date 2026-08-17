"use client";

/**
 * Audit Trail.
 *
 * Read-only by construction: every row was written by a database trigger
 * (migration 041), never by application code choosing to log something, and
 * accounting_audit_events is append-only even for the service role. There is
 * no edit or delete affordance here because there is no edit or delete path.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History, Loader2, Undo2 } from "lucide-react";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  auditActionLabel,
  auditEntityLabel,
  isReversalAction,
  type AuditEvent,
} from "@/lib/accounting/audit-trail";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

const PAGE_SIZE = 25;

export function AuditTrail() {
  const period = useEntityPeriod();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (companyId: string, pageOffset: number, actionFilter: string, entityFilter: string) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ companyId, limit: String(PAGE_SIZE), offset: String(pageOffset) });
      if (actionFilter) params.set("action", actionFilter);
      if (entityFilter) params.set("entityType", entityFilter);
      const response = await fetch(`/api/accounting/audit-events?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load the audit trail.");
      setEvents(data.events ?? []);
      setTotal(data.total ?? 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the audit trail.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId) void load(period.companyId, offset, action, entityType);
  }, [period.companyId, offset, action, entityType, load]);

  useEffect(() => {
    setOffset(0);
  }, [action, entityType, period.companyId]);

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={entityType}
              onChange={(event) => setEntityType(event.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            >
              <option value="">All record types</option>
              {Object.entries(AUDIT_ENTITY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <select
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            >
              <option value="">All actions</option>
              {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        }
      />

      {error || (!period.companyId && !period.loading) ? (
        // The !period.companyId case covers entity loading itself failing (or the
        // workspace having none) — load() below never runs without a companyId, so
        // `error` alone would never surface that; period.error would go unread.
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          {error || period.error || "No accounting entities are set up for this workspace yet."}
        </p>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            Audit trail
          </h2>
          <p className="text-xs font-semibold text-slate-500">{total} event{total === 1 ? "" : "s"}</p>
        </div>

        {period.loading || (loading && period.companyId) ? (
          <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
          </p>
        ) : !period.companyId ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Unable to load — see the error above.</p>
        ) : !events.length ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
            No accounting events recorded for this entity yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">Accounting audit events</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">When</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Event</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Record</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                      {formatLedgerDate(event.createdAt.slice(0, 10))}
                      <span className="ml-1 text-xs text-slate-400">{new Date(event.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}</span>
                    </td>
                    <td className="px-4 py-2 font-semibold text-navy-950">
                      <span className="inline-flex items-center gap-1.5">
                        {isReversalAction(event.action) ? <Undo2 className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" /> : null}
                        {auditActionLabel(event.action)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {auditEntityLabel(event.entityType)}
                      <span className="ml-1 font-mono text-xs text-slate-400">{event.entityId.slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {typeof event.metadata?.reason === "string" ? event.metadata.reason : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Newer
            </button>
            <p className="text-xs font-semibold text-slate-500">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </p>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Older <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

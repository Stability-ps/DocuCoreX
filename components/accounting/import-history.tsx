"use client";

/**
 * Import History.
 *
 * Read-only, the same way the underlying tables are: every batch here was
 * written once, at commit, and never touched again. This screen's only job
 * is to make a past import's error report reachable again — those rejected
 * rows were never written anywhere else, so accounting_import_batch_errors
 * is the only place their detail survives past the request that rejected them.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import { importBatchStatus, importTypeLabel, type ImportBatch } from "@/lib/accounting/import-history";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

const STATUS_STYLE = {
  complete: { icon: CheckCircle2, className: "text-emerald-700", label: "Complete" },
  partial: { icon: AlertTriangle, className: "text-amber-700", label: "Partial" },
  failed: { icon: XCircle, className: "text-red-700", label: "Failed" },
};

export function ImportHistory() {
  const period = useEntityPeriod();
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (companyId: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/accounting/import-history?companyId=${encodeURIComponent(companyId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load import history.");
      setBatches(data.batches ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load import history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId) void load(period.companyId);
  }, [period.companyId, load]);

  return (
    <div className="space-y-4">
      <EntityPeriodBar {...period} />

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Past imports</h2>
        </div>
        {loading ? (
          <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
          </p>
        ) : !batches.length ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
            No chart-of-accounts or journal imports have been committed for this entity yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">Import batches</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Type</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">File</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Valid</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Rejected</th>
                  <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                  <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const status = STATUS_STYLE[importBatchStatus(batch)];
                  const StatusIcon = status.icon;
                  return (
                    <tr key={batch.id} className="border-b border-slate-100 last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                        {formatLedgerDate(batch.createdAt.slice(0, 10))}
                        <span className="ml-1 text-xs text-slate-400">
                          {new Date(batch.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </td>
                      <td className="px-4 py-2 font-semibold text-navy-950">{importTypeLabel(batch.importType)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{batch.filename}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">{batch.validGroups} / {batch.totalGroups}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">{batch.rejectedGroups}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1.5 font-semibold ${status.className}`}>
                          <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" /> {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {batch.rejectedGroups ? (
                          <a
                            href={`/api/accounting/import-history?batchId=${encodeURIComponent(batch.id)}&format=csv`}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50"
                          >
                            <Download className="h-3 w-3" aria-hidden="true" /> Error report
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

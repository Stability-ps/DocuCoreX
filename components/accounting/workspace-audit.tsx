"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Statement coverage and the audit trail.
 *
 * Both are workspace-scoped for the same reason: they are statements about the
 * whole engagement, and a per-run view cannot see what is absent. A missing
 * month is invisible in every other screen in this product — the transactions
 * that would have been in it simply are not there, and nothing looks wrong.
 */

type CoverageStatus = "reconciled" | "present" | "transactions_only" | "missing";

type CoverageResponse = {
  coverage: {
    months: string[];
    rows: Array<{ accountLabel: string; cells: Array<{ month: string; status: CoverageStatus }> }>;
    coveragePercent: number;
    missing: Array<{ accountLabel: string; month: string }>;
    accountsTracked: number;
    statementsReceived: number;
    statementsReconciled: number;
    engagementInferred: boolean;
  };
  engagement: { startDate: string | null; endDate: string | null; expectedAccounts: string[] };
};

type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
};

const STATUS_STYLE: Record<CoverageStatus, { mark: string; className: string; title: string }> = {
  reconciled: { mark: "✓", className: "bg-emerald-100 text-emerald-800", title: "Statement present and reconciled" },
  present: { mark: "•", className: "bg-slate-100 text-slate-600", title: "Statement present but not reconciled" },
  // Named for what it points at: no closing balance means reconciliation was
  // never possible, which is an extraction problem, not a bookkeeping one.
  transactions_only: {
    mark: "~",
    className: "bg-amber-100 text-amber-800",
    title: "Transactions only — no closing balance was found, so this statement cannot be reconciled",
  },
  missing: { mark: "✕", className: "bg-rose-100 text-rose-800", title: "No statement for this month" },
};

export function CoverageView() {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ startDate: string; endDate: string; expectedAccounts: string }>({
    startDate: "",
    endDate: "",
    expectedAccounts: "",
  });

  const apply = useCallback((body: CoverageResponse) => {
    setData(body);
    setDraft({
      startDate: body.engagement.startDate ?? "",
      endDate: body.engagement.endDate ?? "",
      expectedAccounts: body.engagement.expectedAccounts.join(", "),
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/accounting/coverage");
        const body = (await response.json()) as CoverageResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load statement coverage.");
        apply(body);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load statement coverage.");
      }
    })();
  }, [apply]);

  const saveEngagement = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/accounting/coverage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: draft.startDate || null,
          endDate: draft.endDate || null,
          expectedAccounts: draft.expectedAccounts.split(",").map((account) => account.trim()).filter(Boolean),
        }),
      });
      const body = (await response.json()) as CoverageResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || "The engagement could not be saved.");
      apply(body);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The engagement could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">{error}</div>;
  if (!data) return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-400">Loading…</div>;

  const { coverage } = data;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        {[
          { label: "Coverage", value: `${coverage.coveragePercent}%` },
          { label: "Statements received", value: String(coverage.statementsReceived) },
          { label: "Reconciled", value: String(coverage.statementsReconciled) },
          { label: "Accounts tracked", value: String(coverage.accountsTracked) },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-center">
            <p className="text-sm font-black text-navy-950">{card.value}</p>
            <p className="text-[10px] font-bold text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>

      {/* The most important sentence on this screen. Without a stated
          engagement, only gaps BETWEEN held statements are provable — a month
          before the earliest statement may simply predate the account. */}
      {coverage.engagementInferred ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          The period below is inferred from the statements you have uploaded, so only gaps between them are shown. Set
          an engagement period to check for statements missing before the earliest or after the latest.
        </p>
      ) : null}

      {coverage.months.length ? (
        <div className="overflow-auto rounded-lg border border-slate-100">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-2 font-black">Account</th>
                {coverage.months.map((month) => (
                  <th key={month} className="px-1 py-2 text-center font-black">
                    {month.slice(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {coverage.rows.map((row) => (
                <tr key={row.accountLabel} className="border-t border-slate-100">
                  <td className="whitespace-nowrap px-2 py-1.5 font-bold text-navy-950">{row.accountLabel}</td>
                  {row.cells.map((cell) => {
                    const style = STATUS_STYLE[cell.status];
                    return (
                      <td key={cell.month} className="px-1 py-1.5 text-center">
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded font-black ${style.className}`} title={style.title}>
                          {style.mark}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">
          No statements with a period end date yet.
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-[10px] font-bold text-slate-500">
        {(Object.keys(STATUS_STYLE) as CoverageStatus[]).map((status) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded font-black ${STATUS_STYLE[status].className}`}>
              {STATUS_STYLE[status].mark}
            </span>
            {STATUS_STYLE[status].title}
          </span>
        ))}
      </div>

      {coverage.missing.length ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-xs font-black text-rose-900">Missing statements</p>
          <ul className="mt-1 space-y-0.5">
            {coverage.missing.map((entry) => (
              <li key={`${entry.accountLabel}-${entry.month}`} className="text-[11px] font-semibold text-rose-800">
                {entry.month} — {entry.accountLabel}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200 p-3">
        <p className="text-[10px] font-black uppercase tracking-wide text-slate-500">Engagement</p>
        <p className="mt-1 text-[11px] font-medium text-slate-500">
          Setting a period lets coverage report statements missing outside the range you have uploaded. Naming an
          expected account surfaces one that has never provided anything at all — which leaves no other trace.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[150px_150px_1fr_auto]">
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">Start</span>
            <input type="date" value={draft.startDate} onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))} className="h-8 w-full rounded border border-slate-200 px-2 text-xs font-semibold" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">End</span>
            <input type="date" value={draft.endDate} onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value }))} className="h-8 w-full rounded border border-slate-200 px-2 text-xs font-semibold" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">Expected accounts (comma separated)</span>
            <input value={draft.expectedAccounts} onChange={(e) => setDraft((d) => ({ ...d, expectedAccounts: e.target.value }))} placeholder="Standard Bank 1234, Credit Card 5678" className="h-8 w-full rounded border border-slate-200 px-2 text-xs font-semibold" />
          </label>
          <button type="button" disabled={saving} onClick={() => void saveEngagement()} className="h-8 self-end rounded-lg bg-royal-600 px-3 text-xs font-bold text-white hover:bg-royal-700 disabled:bg-slate-300">
            Save
          </button>
        </div>
        {error ? <p className="mt-1 text-[11px] font-bold text-rose-700">{error}</p> : null}
      </div>
    </div>
  );
}

export function AuditTrailView() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/accounting/audit-trail");
        const body = (await response.json()) as { entries?: AuditEntry[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load the audit trail.");
        setEntries(body.entries ?? []);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load the audit trail.");
        setEntries([]);
      }
    })();
  }, []);

  if (!entries) return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-400">Loading…</div>;
  if (error) return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">{error}</div>;

  if (!entries.length) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">
        No recorded actions yet. Category and VAT changes, tags, transfer decisions, recurring confirmations and
        engagement changes are all recorded here as they happen.
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded-lg border border-slate-100">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-2 py-2 font-black">When</th>
            <th className="px-2 py-2 font-black">Action</th>
            <th className="px-2 py-2 font-black">Entity</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-t border-slate-100">
              <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">
                {entry.createdAt.slice(0, 16).replace("T", " ")}
              </td>
              <td className="px-2 py-1.5 font-bold text-navy-950">{entry.action.replace(/_/g, " ")}</td>
              <td className="px-2 py-1.5 font-semibold text-slate-500">{entry.entityType.replace(/_/g, " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tabbed shell for the workspace-scoped audit views. */
export function WorkspaceAudit() {
  const [tab, setTab] = useState<"coverage" | "trail">("coverage");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-black text-navy-950">Across the engagement</h3>
        <div className="ml-auto flex gap-1">
          {(["coverage", "trail"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-black ${tab === id ? "bg-royal-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            >
              {id === "coverage" ? "Statement Coverage" : "Audit Trail"}
            </button>
          ))}
        </div>
      </div>
      {tab === "coverage" ? <CoverageView /> : <AuditTrailView />}
    </div>
  );
}

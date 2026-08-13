"use client";

/**
 * Chart of Accounts.
 *
 * Read-only in this stage. Editing, import and export are the next PR, and a
 * disabled "Add account" button here would be exactly the dead control the
 * specification rules out — so it is absent rather than present-and-inert.
 *
 * The entity selector is not a convenience. An accountant holding several
 * clients in one workspace must be able to see, at a glance, whose chart is on
 * screen; §40 requires the active entity to be unambiguous.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Building2, Loader2, Lock, RefreshCw } from "lucide-react";
import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPE_ORDER,
  type AccountingEntity,
  type AccountType,
  type LedgerAccount,
} from "@/lib/accounting/chart";

const VAT_LABELS: Record<string, string> = {
  standard: "Standard-rated",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
  out_of_scope: "No VAT",
  review: "Review",
};

export function ChartOfAccounts() {
  const [entities, setEntities] = useState<AccountingEntity[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (targetCompanyId?: string) => {
    setLoading(true);
    setError("");
    try {
      const query = targetCompanyId ? `?companyId=${encodeURIComponent(targetCompanyId)}` : "";
      const response = await fetch(`/api/accounting/chart-of-accounts${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load the chart of accounts.");

      setEntities(data.entities ?? []);
      if (data.accounts) {
        setAccounts(data.accounts);
        setCompanyId(targetCompanyId ?? null);
      } else {
        // First load with no entity chosen: open the default entity, which is the
        // one the workspace already treats as primary.
        const preferred = (data.entities ?? []).find((entity: AccountingEntity) => entity.isDefault) ?? (data.entities ?? [])[0];
        if (preferred) {
          setCompanyId(preferred.id);
          const followUp = await fetch(`/api/accounting/chart-of-accounts?companyId=${encodeURIComponent(preferred.id)}`);
          const followUpData = await followUp.json();
          if (!followUp.ok) throw new Error(followUpData?.error ?? "Unable to load the chart of accounts.");
          setAccounts(followUpData.accounts ?? []);
        } else {
          setAccounts([]);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the chart of accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const entity = entities.find((candidate) => candidate.id === companyId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading chart of accounts…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm font-semibold text-red-800">{error}</p>
        <button
          type="button"
          onClick={() => void load(companyId ?? undefined)}
          className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  if (!entities.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
        <Building2 className="mx-auto h-10 w-10 text-slate-300" aria-hidden="true" />
        <h2 className="mt-4 text-base font-bold text-navy-950">No entity configured</h2>
        <p className="mx-auto mt-1 max-w-md text-sm font-semibold text-slate-500">
          A chart of accounts belongs to a company. Add a company profile in Settings and its starter chart is created
          with it.
        </p>
      </div>
    );
  }

  const grouped = ACCOUNT_TYPE_ORDER.map((type) => ({
    type,
    accounts: accounts.filter((account) => account.accountType === type),
  })).filter((group) => group.accounts.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor="entity-select" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            Entity
          </label>
          <select
            id="entity-select"
            value={companyId ?? ""}
            onChange={(event) => void load(event.target.value)}
            className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            {entities.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
        {entity ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-semibold text-slate-500">
            <div>
              <dt className="inline">Currency: </dt>
              <dd className="inline text-navy-950">{entity.baseCurrency}</dd>
            </div>
            <div>
              <dt className="inline">Reporting framework: </dt>
              <dd className="inline text-navy-950">{entity.reportingFramework ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="inline">Accounts: </dt>
              <dd className="inline tabular-nums text-navy-950">{accounts.length}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      {!accounts.length ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-400" aria-hidden="true" />
          <h2 className="mt-4 text-base font-bold text-navy-950">No accounts for this entity</h2>
          <p className="mx-auto mt-1 max-w-md text-sm font-semibold text-slate-500">
            Every entity is created with a starter chart. If this one is empty, the accounting migration has not yet run
            against this database.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <caption className="sr-only">
                Chart of accounts for {entity?.name ?? "the selected entity"}
              </caption>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Code</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Normal balance</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">VAT default</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                </tr>
              </thead>
              {grouped.map((group) => (
                <tbody key={group.type}>
                  <tr className="border-b border-slate-200 bg-slate-50/60">
                    <th
                      scope="colgroup"
                      colSpan={5}
                      className="px-4 py-2 text-left text-xs font-black uppercase tracking-wide text-navy-950"
                    >
                      {ACCOUNT_TYPE_LABELS[group.type as AccountType]}
                    </th>
                  </tr>
                  {group.accounts.map((account) => (
                    <tr key={account.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-2 font-semibold tabular-nums text-navy-950">{account.code}</td>
                      <td className="px-4 py-2 font-medium text-navy-950">
                        <span className="flex items-center gap-1.5">
                          {account.name}
                          {account.isSystem ? (
                            <span title="System account — required by the accounting engine">
                              <Lock className="h-3 w-3 text-slate-400" aria-label="System account" />
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-4 py-2 capitalize text-slate-600">{account.normalBalance}</td>
                      <td className="px-4 py-2 text-slate-600">
                        {account.vatDefault ? VAT_LABELS[account.vatDefault] ?? account.vatDefault : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <span className={account.isActive ? "text-emerald-700" : "text-slate-500"}>
                          {account.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      )}

      <p className="text-xs font-semibold text-slate-500">
        The starter chart is the chart this product already reports against, transcribed unchanged so no existing export
        changes meaning. Editing, import and export follow in the next stage.
      </p>
    </div>
  );
}

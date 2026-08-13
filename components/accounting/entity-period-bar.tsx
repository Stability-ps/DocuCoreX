"use client";

/**
 * Entity and reporting period, shared by every ledger report.
 *
 * One control, one source of truth. The General Ledger and the Trial Balance
 * must never be able to disagree about which entity or which dates they are
 * showing — an accountant comparing two screens has to be able to assume they
 * are the same books over the same period.
 *
 * The default period is the entity's financial year, derived from its configured
 * year-end rather than from the calendar, because a South African company
 * closing in February does not report on January-to-December.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AccountingEntity } from "@/lib/accounting/chart";
import { financialYearFor } from "@/lib/accounting/ledger";

export type EntityPeriod = {
  entities: AccountingEntity[];
  entity: AccountingEntity | null;
  companyId: string;
  from: string;
  to: string;
  setCompanyId: (value: string) => void;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  loading: boolean;
  error: string;
};

export function useEntityPeriod(): EntityPeriod {
  const [entities, setEntities] = useState<AccountingEntity[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/accounting/chart-of-accounts");
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error ?? "Unable to load entities.");
        if (cancelled) return;
        const list: AccountingEntity[] = data.entities ?? [];
        setEntities(list);
        const preferred = list.find((entity) => entity.isDefault) ?? list[0];
        if (preferred) {
          setCompanyId(preferred.id);
          const year = financialYearFor(preferred.financialYearEndMonth, preferred.financialYearEndDay, new Date());
          setFrom(year.from);
          setTo(year.to);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load entities.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const entity = useMemo(() => entities.find((candidate) => candidate.id === companyId) ?? null, [entities, companyId]);

  const changeEntity = useCallback(
    (value: string) => {
      setCompanyId(value);
      const next = entities.find((candidate) => candidate.id === value);
      if (next) {
        const year = financialYearFor(next.financialYearEndMonth, next.financialYearEndDay, new Date());
        setFrom(year.from);
        setTo(year.to);
      }
    },
    [entities],
  );

  return { entities, entity, companyId, from, to, setCompanyId: changeEntity, setFrom, setTo, loading, error };
}

export function EntityPeriodBar({
  entities,
  entity,
  companyId,
  from,
  to,
  setCompanyId,
  setFrom,
  setTo,
  right,
}: EntityPeriod & { right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ledger-entity" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            Entity
          </label>
          <select
            id="ledger-entity"
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
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
        <div>
          <label htmlFor="ledger-from" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            From
          </label>
          <input
            id="ledger-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          />
        </div>
        <div>
          <label htmlFor="ledger-to" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            To
          </label>
          <input
            id="ledger-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          />
        </div>
        {entity ? (
          <p className="pb-2 text-xs font-semibold text-slate-500">
            Financial year end {entity.financialYearEndDay}/{entity.financialYearEndMonth} · {entity.baseCurrency}
          </p>
        ) : null}
      </div>
      {right}
    </div>
  );
}

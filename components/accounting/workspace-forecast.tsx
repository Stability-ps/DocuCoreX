"use client";

import { useEffect, useState } from "react";

/**
 * Cash forecast view.
 *
 * The rule this component follows: a projected balance never appears without
 * the assumptions it rests on. Not in a tooltip, not behind a disclosure — in
 * the same view, unavoidably. Someone reads "R412,000 in 60 days" and decides
 * whether to make a payment, and the two numbers that matter most are the ones
 * most easily confused: what is committed, and what is estimated.
 */

type Horizon = {
  days: number;
  endDate: string;
  committedOutflow: number;
  estimatedInflow: number;
  balanceCommittedOnly: number;
  balanceWithEstimatedInflow: number;
};

type Forecast =
  | { possible: false; reason: string; assumptions: string[] }
  | {
      possible: true;
      openingBalance: number;
      openingBalanceAsAt: string;
      balanceAgeDays: number;
      horizons: Horizon[];
      commitments: Array<{ merchant: string; amount: number; expectedDate: string; frequency: string }>;
      shortfall: { days: number; date: string; projectedBalance: number; largestCommitments: Array<{ merchant: string; amount: number }> } | null;
      assumptions: string[];
    };

const money = (value: number) =>
  `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function WorkspaceForecast() {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/accounting/forecast");
        const body = (await response.json()) as Forecast & { error?: string };
        if (!response.ok) throw new Error((body as { error?: string }).error || "Unable to build the forecast.");
        setForecast(body);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to build the forecast.");
      }
    })();
  }, []);

  if (error) {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">{error}</div>;
  }
  if (!forecast) {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-400">Loading…</div>;
  }

  // The refusal is the answer, rendered as guidance rather than as an error. A
  // flat line repeating today's balance for 90 days would look like a finding.
  if (!forecast.possible) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-black text-navy-950">Cash forecast</h3>
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
          {forecast.reason}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-black text-navy-950">Cash forecast</h3>
        <p className="text-[11px] font-semibold text-slate-500">
          From {money(forecast.openingBalance)} as at {forecast.openingBalanceAsAt}
          {forecast.balanceAgeDays > 45 ? ` · ${forecast.balanceAgeDays} days old` : ""}
        </p>
      </div>

      {/* Committed and estimated are given equal visual weight and separate
          columns. A single blended balance would let the estimate inherit the
          credibility of the commitment. */}
      <div className="overflow-auto rounded-lg border border-slate-100">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-2 py-2 font-black">Horizon</th>
              <th className="px-2 py-2 text-right font-black">Committed out</th>
              <th className="px-2 py-2 text-right font-black">Balance (committed only)</th>
              <th className="px-2 py-2 text-right font-black">Estimated in</th>
              <th className="px-2 py-2 text-right font-black">Balance (with estimate)</th>
            </tr>
          </thead>
          <tbody>
            {forecast.horizons.map((horizon) => (
              <tr key={horizon.days} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-black text-navy-950">
                  {horizon.days} days
                  <span className="ml-1 font-semibold text-slate-400">to {horizon.endDate}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-700">{money(horizon.committedOutflow)}</td>
                <td className={`px-2 py-1.5 text-right font-black ${horizon.balanceCommittedOnly < 0 ? "text-rose-700" : "text-navy-950"}`}>
                  {money(horizon.balanceCommittedOnly)}
                </td>
                <td className="px-2 py-1.5 text-right font-semibold text-slate-500">
                  {horizon.estimatedInflow ? money(horizon.estimatedInflow) : "—"}
                </td>
                <td className="px-2 py-1.5 text-right font-bold text-slate-600">
                  {money(horizon.balanceWithEstimatedInflow)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {forecast.shortfall ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-xs font-black text-rose-900">
            Possible cash shortfall around {forecast.shortfall.date} — projected {money(forecast.shortfall.projectedBalance)}
          </p>
          <p className="mt-1 text-[11px] font-semibold text-rose-800">
            Largest upcoming commitments:{" "}
            {forecast.shortfall.largestCommitments.map((commitment) => `${commitment.merchant} ${money(commitment.amount)}`).join(" · ")}
          </p>
        </div>
      ) : null}

      {forecast.commitments.length ? (
        <div>
          <p className="mb-1 text-[10px] font-black uppercase tracking-wide text-slate-400">Confirmed commitments due</p>
          <ul className="space-y-0.5">
            {forecast.commitments.slice(0, 12).map((commitment, index) => (
              <li key={`${commitment.merchant}-${commitment.expectedDate}-${index}`} className="flex justify-between text-[11px] font-semibold text-slate-600">
                <span>
                  {commitment.expectedDate} · {commitment.merchant}
                </span>
                <span className="font-bold text-slate-700">{money(commitment.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Always rendered, never collapsed. If an assumption cannot be stated
          plainly, the projection should not be shown at all. */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
        <p className="text-[10px] font-black uppercase tracking-wide text-slate-500">Assumptions</p>
        <ul className="mt-1 space-y-0.5">
          {forecast.assumptions.map((assumption) => (
            <li key={assumption} className="text-[11px] font-medium text-slate-600">
              {assumption}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[10px] font-semibold text-slate-400">
          Projections are estimates based on historical data and confirmed inputs, not predictions.
        </p>
      </div>
    </div>
  );
}

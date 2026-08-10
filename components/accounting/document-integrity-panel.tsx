"use client";

import { useEffect, useState } from "react";

/**
 * Document integrity indicators for a statement.
 *
 * The presentation problem here is the whole problem. The underlying module
 * deliberately produces no score, because no defensible one exists — but a UI
 * can reintroduce false certainty without any new data, simply by looking
 * authoritative. A red shield, a big number, a "PASSED" badge: each would say
 * more than the observations support.
 *
 * So this renders a plain list of findings, gives the notable ones a muted
 * amber rather than a red, and puts each innocent explanation directly beneath
 * the finding it belongs to — not in a footnote, where a reader scanning for
 * problems would skip it. An indicator paired with its common benign cause is
 * information. The same indicator alone is an accusation.
 */

type Observation = {
  id: string;
  label: string;
  finding: string;
  notable: boolean;
  benignExplanation?: string;
};

type Integrity = {
  observations: Observation[];
  notableCount: number;
  assessment: string;
};

export function DocumentIntegrityPanel({ statementId }: { statementId: string }) {
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/accounting/fnb/runs/${statementId}/integrity`);
        const body = (await response.json()) as Integrity & { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to inspect the document.");
        if (!cancelled) setIntegrity(body);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to inspect the document.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [statementId]);

  if (error) {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-500">{error}</div>;
  }
  if (!integrity) {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-400">Inspecting document…</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Document integrity</h4>
        {/* A count of things to look at, never a percentage. "3 indicators" is
            checkable; "89.5% authentic" is a weighted guess that reads as a
            measurement. */}
        <span className="text-[11px] font-bold text-slate-500">
          {integrity.notableCount === 0
            ? "Nothing flagged"
            : `${integrity.notableCount} indicator${integrity.notableCount === 1 ? "" : "s"}`}
        </span>
      </div>

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {integrity.observations.map((observation) => (
          <li key={observation.id} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-bold text-navy-950">{observation.label}</span>
              <span
                className={`text-xs font-semibold ${observation.notable ? "text-amber-700" : "text-slate-600"}`}
              >
                {observation.finding}
              </span>
            </div>
            {/* Directly beneath the finding, not in a footnote. A reader
                scanning for problems must not be able to see the flag without
                seeing its ordinary explanation. */}
            {observation.benignExplanation ? (
              <p className="mt-1 text-[11px] font-medium text-slate-500">{observation.benignExplanation}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <p
        className={`rounded-lg px-3 py-2 text-[11px] font-semibold ${
          integrity.notableCount === 0 ? "bg-slate-50 text-slate-600" : "bg-amber-50 text-amber-800"
        }`}
      >
        {integrity.assessment}
      </p>

      <p className="text-[10px] font-medium text-slate-400">
        These describe the PDF container only — how the file was saved, not what it says. They are integrity
        indicators, not findings of fraud, and no check here examines the statement&rsquo;s content.
      </p>
    </div>
  );
}

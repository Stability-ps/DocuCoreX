"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Workspace-scoped insight views.
 *
 * The existing module panels are statement-scoped: they analyse the run you
 * have selected. That is the right shape for VAT or a difference inspector, and
 * the wrong shape for everything in this file. A transfer's two legs are on two
 * different statements; a monthly commitment only becomes visible across
 * several. Both questions are unanswerable from one run, which is why these
 * read from the workspace endpoints instead.
 *
 * Kept in its own file rather than added to accounting-intelligence.tsx, which
 * is already over 4,000 lines.
 */

type TransferCandidate = {
  outbound: { transactionId: string; accountLabel: string; date: string | null; description: string };
  inbound: { transactionId: string; accountLabel: string; date: string | null; description: string };
  amount: number;
  strength: "strong" | "possible";
  evidence: string[];
};

type RecurringPattern = {
  merchant: string;
  frequency: string;
  averageAmount: number;
  amountIsStable: boolean;
  lastSeen: string;
  nextExpected: string;
  confidence: number;
  commonCategory: string | null;
  occurrences: unknown[];
};

const money = (value: number) =>
  `R${value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-500">{children}</div>;
}

function Loading() {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-400">Loading…</div>;
}

export function TransfersView() {
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/accounting/transfers");
      const body = (await response.json()) as { candidates?: TransferCandidate[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load transfer candidates.");
      setCandidates(body.candidates ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load transfer candidates.");
      setCandidates([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (candidate: TransferCandidate, status: "confirmed" | "rejected") => {
    const key = `${candidate.outbound.transactionId}:${candidate.inbound.transactionId}`;
    setBusy(key);
    setError(null);
    try {
      const response = await fetch("/api/accounting/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundTransactionId: candidate.outbound.transactionId,
          inboundTransactionId: candidate.inbound.transactionId,
          status,
          evidence: candidate.evidence,
        }),
      });
      const body = (await response.json()) as { candidates?: TransferCandidate[]; error?: string };
      if (!response.ok) throw new Error(body.error || "The decision could not be saved.");
      setCandidates(body.candidates ?? []);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "The decision could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  if (candidates === null) return <Loading />;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-500">
        Money moved between accounts you own is neither income nor expense. Confirming a transfer removes it from both
        sides of cashflow and flow of funds. Nothing is confirmed automatically.
      </p>
      {error ? <p className="text-xs font-bold text-rose-700">{error}</p> : null}

      {!candidates.length ? (
        <Empty>
          No transfer candidates. Two statements from different accounts, with matching amounts a few days apart, are
          needed before a pairing can be suggested.
        </Empty>
      ) : (
        candidates.map((candidate) => {
          const key = `${candidate.outbound.transactionId}:${candidate.inbound.transactionId}`;
          return (
            <div key={key} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-black text-navy-950">{money(candidate.amount)}</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                    candidate.strength === "strong" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {candidate.strength === "strong" ? "Strong match" : "Possible match"}
                </span>
              </div>

              <div className="mt-2 grid gap-1 text-xs font-semibold text-slate-600 sm:grid-cols-2">
                <p>
                  <span className="text-slate-400">Out</span> {candidate.outbound.accountLabel} ·{" "}
                  {candidate.outbound.date ?? "—"}
                </p>
                <p>
                  <span className="text-slate-400">In</span> {candidate.inbound.accountLabel} ·{" "}
                  {candidate.inbound.date ?? "—"}
                </p>
              </div>

              {/* The evidence is shown so the accountant can disagree with it,
                  which is the only reason a candidate is worth surfacing. */}
              <ul className="mt-2 flex flex-wrap gap-1">
                {candidate.evidence.map((line) => (
                  <li key={line} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                    {line}
                  </li>
                ))}
              </ul>

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy === key}
                  onClick={() => void decide(candidate, "confirmed")}
                  className="rounded-lg bg-royal-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-royal-700 disabled:bg-slate-300"
                >
                  Confirm transfer
                </button>
                <button
                  type="button"
                  disabled={busy === key}
                  onClick={() => void decide(candidate, "rejected")}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
                >
                  Not a transfer
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export function RecurringView() {
  const [patterns, setPatterns] = useState<RecurringPattern[] | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/accounting/recurring");
      const body = (await response.json()) as { patterns?: RecurringPattern[]; confirmed?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load recurring patterns.");
      setPatterns(body.patterns ?? []);
      setConfirmed(body.confirmed ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load recurring patterns.");
      setPatterns([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (merchant: string, status: "confirmed" | "dismissed") => {
    setBusy(merchant);
    setError(null);
    try {
      const response = await fetch("/api/accounting/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant, status }),
      });
      const body = (await response.json()) as { patterns?: RecurringPattern[]; confirmed?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error || "The decision could not be saved.");
      setPatterns(body.patterns ?? []);
      setConfirmed(body.confirmed ?? []);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "The decision could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  if (patterns === null) return <Loading />;

  const isConfirmed = (merchant: string) => confirmed.some((entry) => entry.toLowerCase() === merchant.toLowerCase());

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-500">
        Detected from at least three payments with a consistent interval. Only confirmed commitments are used by
        Forecasting — a detected pattern on its own is a suggestion, not an obligation.
      </p>
      {error ? <p className="text-xs font-bold text-rose-700">{error}</p> : null}

      {!patterns.length ? (
        <Empty>No recurring patterns yet. Three payments to the same payee at a regular interval are needed.</Empty>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-100">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-2 font-black">Merchant</th>
                <th className="px-2 py-2 font-black">Frequency</th>
                <th className="px-2 py-2 text-right font-black">Average</th>
                <th className="px-2 py-2 font-black">Last Seen</th>
                <th className="px-2 py-2 font-black">Next Expected</th>
                <th className="px-2 py-2 text-right font-black">Confidence</th>
                <th className="px-2 py-2 font-black">Status</th>
              </tr>
            </thead>
            <tbody>
              {patterns.map((pattern) => (
                <tr key={pattern.merchant} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-black text-navy-950">{pattern.merchant}</td>
                  <td className="px-2 py-1.5 font-semibold text-slate-600">{pattern.frequency}</td>
                  <td className="px-2 py-1.5 text-right font-bold text-slate-700">
                    {money(pattern.averageAmount)}
                    {/* A varying amount is stated, not hidden: the rhythm can be
                        real while the figure moves. */}
                    {!pattern.amountIsStable ? (
                      <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] font-black text-amber-800" title="The amount varies between payments.">
                        VARIES
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">{pattern.lastSeen}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-600">{pattern.nextExpected}</td>
                  <td className="px-2 py-1.5 text-right font-bold text-slate-600">{pattern.confidence}</td>
                  <td className="px-2 py-1.5">
                    {isConfirmed(pattern.merchant) ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                        Confirmed
                      </span>
                    ) : (
                      <span className="flex gap-1">
                        <button
                          type="button"
                          disabled={busy === pattern.merchant}
                          onClick={() => void decide(pattern.merchant, "confirmed")}
                          className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-royal-700 hover:bg-slate-50 disabled:text-slate-300"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled={busy === pattern.merchant}
                          onClick={() => void decide(pattern.merchant, "dismissed")}
                          className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
                        >
                          Not recurring
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Tabbed shell for the workspace-scoped insight views. */
export function WorkspaceInsights() {
  const [tab, setTab] = useState<"transfers" | "recurring">("transfers");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-black text-navy-950">Across all statements</h3>
        <div className="ml-auto flex gap-1">
          {(["transfers", "recurring"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-black ${
                tab === id ? "bg-royal-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {id === "transfers" ? "Transfers" : "Recurring"}
            </button>
          ))}
        </div>
      </div>
      {tab === "transfers" ? <TransfersView /> : <RecurringView />}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

import { formatMoney } from "@/lib/accounting/format";

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

const money = (value: number) => formatMoney(value);

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


type CashflowResponse = {
  summary: {
    months: Array<{ month: string; inflow: number; outflow: number; net: number; bankCharges: number }>;
    totalInflow: number;
    totalOutflow: number;
    netMovement: number;
    bankChargesTotal: number;
    monthsObserved: number;
    monthsSpanned: number;
    hasGaps: boolean;
    averageMonthlyInflow: number;
    averageMonthlyOutflow: number;
    expenseCategories: Array<{ category: string; amount: number; count: number }>;
    incomeCategories: Array<{ category: string; amount: number; count: number }>;
    excludedTransferCount: number;
  };
  balances: Array<{ accountLabel: string; asAt: string | null; balance: number }>;
};

export function CashflowView() {
  const [data, setData] = useState<CashflowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/accounting/cashflow");
        const body = (await response.json()) as CashflowResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load cashflow.");
        setData(body);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load cashflow.");
      }
    })();
  }, []);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Loading />;

  const { summary, balances } = data;
  if (!summary.monthsObserved) return <Empty>No dated transactions yet.</Empty>;

  const maxBar = Math.max(...summary.months.map((month) => Math.max(month.inflow, month.outflow)), 1);

  return (
    <div className="space-y-3">
      {/* Balances are listed per account with the date each was true. They are
          deliberately not summed: adding closing balances from statements that
          end on different dates produces a figure that was never true on any
          single day. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((balance) => (
          <div key={balance.accountLabel} className="rounded-lg border border-slate-200 p-2">
            <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{balance.accountLabel}</p>
            <p className="text-sm font-black text-navy-950">{money(balance.balance)}</p>
            <p className="text-[10px] font-semibold text-slate-500">as at {balance.asAt ?? "unknown"}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {[
          { label: "Total in", value: money(summary.totalInflow) },
          { label: "Total out", value: money(summary.totalOutflow) },
          { label: "Net movement", value: money(summary.netMovement) },
          { label: "Bank charges", value: money(summary.bankChargesTotal) },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-center">
            <p className="text-sm font-black text-navy-950">{card.value}</p>
            <p className="text-[10px] font-bold text-slate-500">{card.label}</p>
          </div>
        ))}
      </div>

      {summary.hasGaps ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          Averages cover {summary.monthsObserved} of {summary.monthsSpanned} months in the period — a statement is
          missing. Monthly figures below are drawn from an incomplete picture.
        </p>
      ) : null}

      {summary.excludedTransferCount ? (
        <p className="text-[11px] font-semibold text-slate-500">
          {summary.excludedTransferCount} transaction{summary.excludedTransferCount === 1 ? "" : "s"} excluded as
          confirmed internal transfers — money moved between your own accounts is neither income nor expense.
        </p>
      ) : null}

      {/* Proportional bars rather than a chart library: the comparison that
          matters is in vs out per month, and that needs no dependency. */}
      <div className="space-y-1">
        {summary.months.map((month) => (
          <div key={month.month} className="flex items-center gap-2 text-[11px]">
            <span className="w-16 shrink-0 font-black text-slate-500">{month.month}</span>
            <span className="flex-1">
              <span className="block h-2 rounded bg-emerald-500" style={{ width: `${(month.inflow / maxBar) * 100}%` }} />
              <span className="mt-0.5 block h-2 rounded bg-slate-400" style={{ width: `${(month.outflow / maxBar) * 100}%` }} />
            </span>
            <span className="w-28 shrink-0 text-right font-bold text-slate-700">{money(month.net)}</span>
          </div>
        ))}
        <p className="text-[10px] font-semibold text-slate-400">Green is money in, grey is money out. Right column is net.</p>
      </div>
    </div>
  );
}

type FlowResponse =
  | { sufficient: false; reason: string; quality: { classifiedValueShare: number } }
  | {
      sufficient: true;
      hubLabel: string;
      nodes: Array<{ id: string; label: string; kind: "source" | "hub" | "use"; amount: number }>;
      edges: Array<{ from: string; to: string; amount: number; share: number }>;
    };

export function FlowOfFundsView() {
  const [data, setData] = useState<FlowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/accounting/flow-of-funds");
        const body = (await response.json()) as FlowResponse & { error?: string };
        if (!response.ok) throw new Error((body as { error?: string }).error || "Unable to load flow of funds.");
        setData(body);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load flow of funds.");
      }
    })();
  }, []);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Loading />;

  // The refusal is rendered as the answer, not as an error. A diagram drawn on
  // thin classification looks exactly as convincing as one drawn on good data,
  // which is why the module declines to draw it at all.
  if (!data.sufficient) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-bold text-amber-900">{data.reason}</p>
        <p className="mt-2 text-[11px] font-semibold text-amber-800">
          Categorise transactions in the Review tab of a statement. A flow diagram built on unclassified money looks
          just as convincing as an accurate one, so it is not shown until the classification can support it.
        </p>
      </div>
    );
  }

  const sources = data.nodes.filter((node) => node.kind === "source");
  const uses = data.nodes.filter((node) => node.kind === "use");

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr]">
      <div className="space-y-1">
        <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Money in</p>
        {sources.map((node) => (
          <div key={node.id} className="rounded border border-emerald-100 bg-emerald-50/60 px-2 py-1">
            <p className="text-xs font-bold text-navy-950">{node.label}</p>
            <p className="text-[11px] font-black text-emerald-700">{money(node.amount)}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center">
        <div className="rounded-lg border border-royal-200 bg-royal-50 px-3 py-2 text-center">
          <p className="text-xs font-black text-royal-800">{data.hubLabel}</p>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Money out</p>
        {uses.map((node) => (
          <div key={node.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
            <p className="text-xs font-bold text-navy-950">{node.label}</p>
            <p className="text-[11px] font-black text-slate-700">{money(node.amount)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tabbed shell for the workspace-scoped insight views. */
export function WorkspaceInsights() {
  const [tab, setTab] = useState<"transfers" | "recurring" | "cashflow" | "flow">("transfers");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-black text-navy-950">Across all statements</h3>
        <div className="ml-auto flex gap-1">
          {(["transfers", "recurring", "cashflow", "flow"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-black ${
                tab === id ? "bg-royal-600 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {{ transfers: "Transfers", recurring: "Recurring", cashflow: "Cashflow", flow: "Flow of Funds" }[id]}
            </button>
          ))}
        </div>
      </div>
      {tab === "transfers" ? <TransfersView /> : null}
      {tab === "recurring" ? <RecurringView /> : null}
      {tab === "cashflow" ? <CashflowView /> : null}
      {tab === "flow" ? <FlowOfFundsView /> : null}
    </div>
  );
}

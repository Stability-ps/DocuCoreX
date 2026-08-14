"use client";

/**
 * Accounts Receivable and Accounts Payable.
 *
 * One component, two exports — AR and AP are structurally identical (party,
 * control account, an open-item side and its unallocated-postings mirror,
 * ageing), so sharing the implementation means a bug found in one is fixed in
 * both rather than fixed once and left in the other.
 *
 * Ageing and open items are read, never computed here — the database derives
 * both (migration 043) the same way it derives a trial balance. Allocation is
 * delegated to accounting_allocate_ar / accounting_allocate_ap; this screen
 * shows the same unallocated-remainder arithmetic the database would itself
 * check, so a refusal is expected before the round trip, not a surprise after.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Link2, Loader2, Plus, Unlink } from "lucide-react";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import type { LedgerAccount } from "@/lib/accounting/chart";
import { AGEING_BUCKET_LABELS, isOverdue, type AgeingRow, type OpenItem, type Party, type UnallocatedPosting } from "@/lib/accounting/receivables-payables";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

type Side = "ar" | "ap";

const COPY = {
  ar: {
    endpoint: "/api/accounting/receivables",
    partyLabel: "Customer",
    partyAction: "create-customer",
    openItemLabel: "Invoice",
    unallocatedLabel: "Receipt",
    controlAccountType: "asset" as const,
    controlAccountLabel: "Accounts Receivable control account",
  },
  ap: {
    endpoint: "/api/accounting/payables",
    partyLabel: "Supplier",
    partyAction: "create-supplier",
    openItemLabel: "Bill",
    unallocatedLabel: "Payment",
    controlAccountType: "liability" as const,
    controlAccountLabel: "Accounts Payable control account",
  },
};

type Loaded = {
  controlAccountId: string | null;
  parties: Party[];
  openItems: OpenItem[];
  unallocated: UnallocatedPosting[];
  ageing: AgeingRow[];
};

async function postJson(endpoint: string, body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ?? "Request failed.");
  return data;
}

function Subledger({ side }: { side: Side }) {
  const copy = COPY[side];
  const period = useEntityPeriod();
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showNewParty, setShowNewParty] = useState(false);
  const [allocating, setAllocating] = useState<OpenItem | null>(null);
  const [controlAccountPick, setControlAccountPick] = useState("");
  const [settingControl, setSettingControl] = useState(false);

  const load = useCallback(async (companyId: string) => {
    setLoading(true);
    setError("");
    try {
      const [dataResponse, chartResponse] = await Promise.all([
        fetch(`${copy.endpoint}?companyId=${encodeURIComponent(companyId)}`),
        fetch(`/api/accounting/chart-of-accounts?companyId=${encodeURIComponent(companyId)}`),
      ]);
      const data = await dataResponse.json();
      const chart = await chartResponse.json();
      if (!dataResponse.ok) throw new Error(data?.error ?? "Unable to load.");
      if (!chartResponse.ok) throw new Error(chart?.error ?? "Unable to load the chart of accounts.");
      setLoaded(data);
      setAccounts((chart.accounts ?? []).filter((a: LedgerAccount) => a.isActive));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy.endpoint]);

  useEffect(() => {
    if (period.companyId) void load(period.companyId);
  }, [period.companyId, load]);

  const controlAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.accountType === copy.controlAccountType), [accounts, copy.controlAccountType]);

  const setControlAccount = async () => {
    if (!controlAccountPick) return;
    setSettingControl(true);
    setError("");
    try {
      await postJson(copy.endpoint, { action: "set-control-account", companyId: period.companyId, accountId: controlAccountPick });
      await load(period.companyId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to set the control account.");
    } finally {
      setSettingControl(false);
    }
  };

  if (loading && !loaded) {
    return (
      <div className="space-y-4">
        <EntityPeriodBar {...period} />
        <p className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-sm font-semibold text-slate-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          <button
            type="button"
            onClick={() => setShowNewParty((v) => !v)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-navy-950 px-3 text-sm font-semibold text-white transition hover:bg-navy-900"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New {copy.partyLabel.toLowerCase()}
          </button>
        }
      />

      {error ? (
        <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {showNewParty ? (
        <NewPartyForm
          endpoint={copy.endpoint}
          action={copy.partyAction}
          label={copy.partyLabel}
          companyId={period.companyId}
          onCancel={() => setShowNewParty(false)}
          onDone={async () => {
            setShowNewParty(false);
            await load(period.companyId);
          }}
        />
      ) : null}

      {!loaded?.controlAccountId ? (
        <section className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-bold text-amber-900">Set the {copy.controlAccountLabel}</h2>
          <p className="text-sm text-amber-800">
            Every {copy.openItemLabel.toLowerCase()} and {copy.unallocatedLabel.toLowerCase()} is a posting to one account. Nothing below can be shown until this
            entity says which account that is.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <select
              value={controlAccountPick}
              onChange={(e) => setControlAccountPick(e.target.value)}
              className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
            >
              <option value="">Select an account…</option>
              {controlAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!controlAccountPick || settingControl}
              onClick={() => void setControlAccount()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-navy-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {settingControl ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Ageing</h2>
            </div>
            {!loaded.ageing.length ? (
              <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Nothing outstanding.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] border-collapse text-sm">
                  <caption className="sr-only">Ageing by {copy.partyLabel.toLowerCase()}</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-left">
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">{copy.partyLabel}</th>
                      {AGEING_BUCKET_LABELS.map((label) => (
                        <th key={label} scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">{label}</th>
                      ))}
                      <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.ageing.map((row) => (
                      <tr key={row.partyId} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2 font-semibold text-navy-950">{row.partyName}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.current)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.days30)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.days60)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-red-700">{formatLedgerMoney(row.days90Plus)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-navy-950">{formatLedgerMoney(row.totalOutstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Open {copy.openItemLabel.toLowerCase()}s</h2>
            </div>
            {!loaded.openItems.length ? (
              <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Nothing outstanding.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] border-collapse text-sm">
                  <caption className="sr-only">Open {copy.openItemLabel.toLowerCase()}s</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-left">
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">{copy.partyLabel}</th>
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Due</th>
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
                      <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Outstanding</th>
                      <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.openItems.map((item) => (
                      <tr key={item.postingId} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2 font-semibold text-navy-950">{item.partyName}</td>
                        <td className="px-4 py-2 text-slate-500">{formatLedgerDate(item.postingDate)}</td>
                        <td className={`px-4 py-2 ${item.dueDate && isOverdue(item, new Date().toISOString().slice(0, 10)) ? "font-semibold text-red-700" : "text-slate-500"}`}>
                          {item.dueDate ? formatLedgerDate(item.dueDate) : "—"}
                        </td>
                        <td className="px-4 py-2 text-slate-600">{item.description ?? "—"}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(item.outstanding)}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setAllocating(item)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50"
                          >
                            <Link2 className="h-3 w-3" aria-hidden="true" /> Allocate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {loaded.unallocated.length ? (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Unallocated {copy.unallocatedLabel.toLowerCase()}s</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[38rem] border-collapse text-sm">
                  <caption className="sr-only">Unallocated {copy.unallocatedLabel.toLowerCase()}s</caption>
                  <thead>
                    <tr className="border-b border-slate-200 text-left">
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">{copy.partyLabel}</th>
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
                      <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
                      <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.unallocated.map((item) => (
                      <tr key={item.postingId} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2 font-semibold text-navy-950">{item.partyName}</td>
                        <td className="px-4 py-2 text-slate-500">{formatLedgerDate(item.postingDate)}</td>
                        <td className="px-4 py-2 text-slate-600">{item.description ?? "—"}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(item.remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}

      {allocating ? (
        <AllocateDialog
          side={side}
          copy={copy}
          companyId={period.companyId}
          item={allocating}
          candidates={(loaded?.unallocated ?? []).filter((u) => u.partyId === allocating.partyId)}
          onCancel={() => setAllocating(null)}
          onDone={async () => {
            setAllocating(null);
            await load(period.companyId);
          }}
        />
      ) : null}
    </div>
  );
}

function NewPartyForm({
  endpoint,
  action,
  label,
  companyId,
  onCancel,
  onDone,
}: {
  endpoint: string;
  action: string;
  label: string;
  companyId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await postJson(endpoint, { action, companyId, name, email: email || null, phone: phone || null });
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Unable to add the ${label.toLowerCase()}.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">New {label.toLowerCase()}</h2>
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
          Cancel
        </button>
        <button type="button" disabled={!name.trim() || submitting} onClick={() => void submit()}
          className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Add
        </button>
      </div>
    </section>
  );
}

function AllocateDialog({
  side,
  copy,
  companyId,
  item,
  candidates,
  onCancel,
  onDone,
}: {
  side: Side;
  copy: (typeof COPY)[Side];
  companyId: string;
  item: OpenItem;
  candidates: UnallocatedPosting[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [postingId, setPostingId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const candidate = candidates.find((c) => c.postingId === postingId) ?? null;
  const maxAmount = candidate ? Math.min(item.outstanding, candidate.remaining) : item.outstanding;

  const submit = async () => {
    if (!candidate) return;
    setSubmitting(true);
    setError("");
    try {
      const body =
        side === "ar"
          ? { action: "allocate", companyId, invoicePostingId: item.postingId, receiptPostingId: candidate.postingId, amount: Number(amount) }
          : { action: "allocate", companyId, billPostingId: item.postingId, paymentPostingId: candidate.postingId, amount: Number(amount) };
      await postJson(copy.endpoint, body);
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to allocate.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-sm font-bold text-navy-950">
          Allocate against {item.partyName}'s {copy.openItemLabel.toLowerCase()} of {formatLedgerMoney(item.outstanding)} outstanding
        </h3>
        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}

        {!candidates.length ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-500">
            No unallocated {copy.unallocatedLabel.toLowerCase()}s for {item.partyName} yet.
          </p>
        ) : (
          <>
            <label className="block">
              <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">{copy.unallocatedLabel}</span>
              <select value={postingId} onChange={(e) => { setPostingId(e.target.value); setAmount(""); }}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
                <option value="">Select…</option>
                {candidates.map((c) => (
                  <option key={c.postingId} value={c.postingId}>
                    {formatLedgerDate(c.postingDate)} — {formatLedgerMoney(c.remaining)} remaining{c.description ? ` — ${c.description}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block max-w-xs">
              <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Amount</span>
              <input type="number" min="0.01" step="0.01" max={maxAmount} value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={candidate ? formatLedgerMoney(maxAmount) : undefined}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
              {candidate ? (
                <span className="mt-1 block text-xs text-slate-500">Up to {formatLedgerMoney(maxAmount)}.</span>
              ) : null}
            </label>
          </>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={!candidate || !amount || Number(amount) <= 0 || Number(amount) > maxAmount + 0.005 || submitting}
            onClick={() => void submit()}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Unlink className="h-3.5 w-3.5" aria-hidden="true" />}
            Allocate
          </button>
        </div>
      </div>
    </div>
  );
}

export function Receivables() {
  return <Subledger side="ar" />;
}

export function Payables() {
  return <Subledger side="ap" />;
}

"use client";

/**
 * Fixed Assets.
 *
 * Cost is stated when an asset is added — the register does not derive it,
 * the same way a reconciliation does not derive the bank's own figure.
 * Accumulated depreciation and net book value ARE derived, from postings, by
 * accounting_fixed_asset_register; this screen never shows a number that
 * function wouldn't itself compute.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import type { LedgerAccount } from "@/lib/accounting/chart";
import {
  DEPRECIATION_METHOD_LABELS,
  disposalEntry,
  type DepreciationMethod,
  type FixedAsset,
} from "@/lib/accounting/fixed-assets";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

type BatchEntry = { assetId: string; description: string; accumulatedDepreciationAccountId: string; amount: number };

async function postJson(body: Record<string, unknown>) {
  const response = await fetch("/api/accounting/fixed-assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error ?? "Request failed.");
  return data;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FixedAssets() {
  const period = useEntityPeriod();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);

  const assetAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.accountType === "asset"), [accounts]);

  const load = useCallback(async (companyId: string) => {
    setLoading(true);
    setError("");
    try {
      const [assetsResponse, chartResponse] = await Promise.all([
        fetch(`/api/accounting/fixed-assets?companyId=${encodeURIComponent(companyId)}`),
        fetch(`/api/accounting/chart-of-accounts?companyId=${encodeURIComponent(companyId)}`),
      ]);
      const assetsData = await assetsResponse.json();
      const chartData = await chartResponse.json();
      if (!assetsResponse.ok) throw new Error(assetsData?.error ?? "Unable to load fixed assets.");
      if (!chartResponse.ok) throw new Error(chartData?.error ?? "Unable to load the chart of accounts.");
      setAssets(assetsData.assets ?? []);
      setAccounts((chartData.accounts ?? []).filter((a: LedgerAccount) => a.isActive));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load fixed assets.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId) void load(period.companyId);
  }, [period.companyId, load]);

  const active = assets.filter((a) => a.isActive);
  const disposed = assets.filter((a) => !a.isActive);

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowBatch((v) => !v)}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
            >
              Run depreciation
            </button>
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-navy-950 px-3 text-sm font-semibold text-white transition hover:bg-navy-900"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add asset
            </button>
          </div>
        }
      />

      {error || (!period.companyId && !period.loading) ? (
        // The !period.companyId case covers entity loading itself failing (or the
        // workspace having none) — load() below never runs without a companyId, so
        // `error` alone would never surface that; period.error would go unread.
        <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error || period.error || "No accounting entities are set up for this workspace yet."}
        </p>
      ) : null}

      {showAdd ? (
        <AddAssetForm
          companyId={period.companyId}
          assetAccounts={assetAccounts}
          onCancel={() => setShowAdd(false)}
          onDone={async () => {
            setShowAdd(false);
            await load(period.companyId);
          }}
        />
      ) : null}

      {showBatch ? (
        <DepreciationBatchPanel
          companyId={period.companyId}
          accounts={accounts}
          onDone={async () => {
            await load(period.companyId);
          }}
        />
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Register</h2>
        </div>
        {period.loading || (loading && period.companyId) ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Loading…</p>
        ) : !period.companyId ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">Unable to load — see the error above.</p>
        ) : !active.length ? (
          <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
            No fixed assets recorded for this entity yet.
          </p>
        ) : (
          <AssetTable assets={active} onDispose={setDisposing} />
        )}
      </section>

      {disposed.length ? (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Disposed</h2>
          </div>
          <AssetTable assets={disposed} onDispose={null} />
        </section>
      ) : null}

      {disposing ? (
        <DisposeDialog
          companyId={period.companyId}
          asset={disposing}
          accounts={accounts}
          onCancel={() => setDisposing(null)}
          onDone={async () => {
            setDisposing(null);
            await load(period.companyId);
          }}
        />
      ) : null}
    </div>
  );
}

function AssetTable({ assets, onDispose }: { assets: FixedAsset[]; onDispose: ((asset: FixedAsset) => void) | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[54rem] border-collapse text-sm">
        <caption className="sr-only">Fixed assets</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left">
            <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
            <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
            <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Acquired</th>
            <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Method</th>
            <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Cost</th>
            <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Accum. Dep.</th>
            <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Net Book Value</th>
            {onDispose ? <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.id} className="border-b border-slate-100 last:border-0">
              <td className="px-4 py-2 font-semibold text-navy-950">{asset.description}</td>
              <td className="px-4 py-2 text-slate-600">{asset.assetAccountCode} · {asset.assetAccountName}</td>
              <td className="px-4 py-2 text-slate-500">{formatLedgerDate(asset.acquisitionDate)}</td>
              <td className="px-4 py-2 text-slate-600">{DEPRECIATION_METHOD_LABELS[asset.depreciationMethod]}</td>
              <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(asset.cost)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(asset.accumulatedDepreciation)}</td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-navy-950">{formatLedgerMoney(asset.netBookValue)}</td>
              {onDispose ? (
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onDispose(asset)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-navy-950 transition hover:bg-slate-50"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" /> Dispose
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddAssetForm({
  companyId,
  assetAccounts,
  onCancel,
  onDone,
}: {
  companyId: string;
  assetAccounts: LedgerAccount[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [description, setDescription] = useState("");
  const [assetAccountId, setAssetAccountId] = useState("");
  const [accumAccountId, setAccumAccountId] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState(todayIso());
  const [cost, setCost] = useState("");
  const [residualValue, setResidualValue] = useState("0");
  const [method, setMethod] = useState<DepreciationMethod>("straight_line");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [ratePercent, setRatePercent] = useState("20");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await postJson({
        action: "create-asset",
        companyId,
        description,
        assetAccountId,
        accumulatedDepreciationAccountId: accumAccountId,
        acquisitionDate,
        cost: Number(cost),
        residualValue: Number(residualValue) || 0,
        depreciationMethod: method,
        usefulLifeMonths: Number(usefulLifeMonths),
        depreciationRatePercent: Number(ratePercent),
      });
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to add the asset.");
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    description.trim() && assetAccountId && accumAccountId && assetAccountId !== accumAccountId && cost && Number(cost) >= 0 &&
    (method === "none" || (method === "straight_line" && Number(usefulLifeMonths) > 0) || (method === "reducing_balance" && Number(ratePercent) > 0));

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Add a fixed asset</h2>
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Toyota Hilux 2024"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Asset account</span>
          <select value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
            <option value="">Select…</option>
            {assetAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Accumulated depreciation account</span>
          <select value={accumAccountId} onChange={(e) => setAccumAccountId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
            <option value="">Select…</option>
            {assetAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Acquisition date</span>
          <input type="date" value={acquisitionDate} onChange={(e) => setAcquisitionDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Cost</span>
          <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Residual value</span>
          <input type="number" min="0" step="0.01" value={residualValue} onChange={(e) => setResidualValue(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
      </div>

      <div>
        <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Depreciation method</span>
        <div className="mt-1 flex gap-1 rounded-lg border border-slate-300 p-1">
          {(["straight_line", "reducing_balance", "none"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setMethod(value)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${method === value ? "bg-navy-950 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
              {DEPRECIATION_METHOD_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      {method === "straight_line" ? (
        <label className="block max-w-xs">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Useful life (months)</span>
          <input type="number" min="1" value={usefulLifeMonths} onChange={(e) => setUsefulLifeMonths(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
      ) : method === "reducing_balance" ? (
        <label className="block max-w-xs">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Annual rate (%)</span>
          <input type="number" min="0.01" max="100" step="0.01" value={ratePercent} onChange={(e) => setRatePercent(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
          Cancel
        </button>
        <button type="button" disabled={!canSubmit || submitting} onClick={() => void submit()}
          className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Add asset
        </button>
      </div>
    </section>
  );
}

function DepreciationBatchPanel({
  companyId,
  accounts,
  onDone,
}: {
  companyId: string;
  accounts: LedgerAccount[];
  onDone: () => void;
}) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [entries, setEntries] = useState<BatchEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ posted: string[]; failed: Array<{ assetId: string; message: string }> } | null>(null);

  const expenseAccounts = useMemo(() => accounts.filter((a) => a.accountType === "expense"), [accounts]);

  const loadPreview = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const [year, mm] = month.split("-");
      const monthEnd = new Date(Date.UTC(Number(year), Number(mm), 0)).toISOString().slice(0, 10);
      const response = await fetch(`/api/accounting/fixed-assets?companyId=${encodeURIComponent(companyId)}&view=depreciation-preview&monthEnd=${monthEnd}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load the depreciation preview.");
      const loaded: BatchEntry[] = data.entries ?? [];
      setEntries(loaded);
      setSelected(new Set(loaded.map((e) => e.assetId)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load the depreciation preview.");
    } finally {
      setLoading(false);
    }
  };

  const post = async () => {
    if (!entries) return;
    setPosting(true);
    setError("");
    try {
      const [year, mm] = month.split("-");
      const monthEnd = new Date(Date.UTC(Number(year), Number(mm), 0)).toISOString().slice(0, 10);
      const chosen = entries.filter((e) => selected.has(e.assetId));
      const outcome = await postJson({ action: "run-depreciation", companyId, monthEnd, expenseAccountId, entries: chosen });
      setResult(outcome);
      setEntries(null);
      onDone();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "Unable to post depreciation.");
    } finally {
      setPosting(false);
    }
  };

  const total = (entries ?? []).filter((e) => selected.has(e.assetId)).reduce((sum, e) => sum + e.amount, 0);

  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Run depreciation</h2>
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}
      {result ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
          Posted {result.posted.length} journal{result.posted.length === 1 ? "" : "s"}.
          {result.failed.length ? ` ${result.failed.length} failed: ${result.failed.map((f) => f.message).join("; ")}` : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Month</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
        </label>
        <button type="button" disabled={loading} onClick={() => void loadPreview()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-50">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Preview
        </button>
      </div>

      {entries ? (
        entries.length ? (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[30rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left">
                    <th className="px-3 py-2"><span className="sr-only">Include</span></th>
                    <th className="px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Asset</th>
                    <th className="px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.assetId} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(entry.assetId)}
                          onChange={(e) => setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(entry.assetId); else next.delete(entry.assetId);
                            return next;
                          })} />
                      </td>
                      <td className="px-3 py-2 font-semibold text-navy-950">{entry.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(entry.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="block max-w-xs">
                <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Depreciation expense account</span>
                <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
                  <option value="">Select…</option>
                  {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </select>
              </label>
              <div className="text-right">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Total</p>
                <p className="text-lg font-bold text-navy-950">{formatLedgerMoney(total)}</p>
              </div>
              <button type="button" disabled={!expenseAccountId || !selected.size || posting} onClick={() => void post()}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-navy-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                Post {selected.size} journal{selected.size === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-500">
            Nothing to depreciate for this month — every eligible asset is already fully depreciated or has already been run.
          </p>
        )
      ) : null}
    </section>
  );
}

function DisposeDialog({
  companyId,
  asset,
  accounts,
  onCancel,
  onDone,
}: {
  companyId: string;
  asset: FixedAsset;
  accounts: LedgerAccount[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [disposalDate, setDisposalDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState("0");
  const [proceedsAccountId, setProceedsAccountId] = useState("");
  const [gainLossAccountId, setGainLossAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const assetAccounts = useMemo(() => accounts.filter((a) => a.isActive && a.accountType === "asset"), [accounts]);
  const otherIncomeAccounts = useMemo(() => accounts.filter((a) => a.accountType === "other_income" || a.accountType === "other_expense"), [accounts]);

  const preview = disposalEntry({ cost: asset.cost, accumulatedDepreciation: asset.accumulatedDepreciation, proceeds: Number(proceeds) || 0 });
  const proceedsNumber = Number(proceeds) || 0;
  const canSubmit = gainLossAccountId && (proceedsNumber === 0 || proceedsAccountId);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await postJson({
        action: "dispose",
        companyId,
        assetId: asset.id,
        disposalDate,
        proceeds: proceedsNumber,
        proceedsAccountId: proceedsNumber > 0 ? proceedsAccountId : null,
        gainLossAccountId,
      });
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to dispose of the asset.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="text-sm font-bold text-navy-950">Dispose of {asset.description}</h3>
        {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Disposal date</span>
            <input type="date" value={disposalDate} onChange={(e) => setDisposalDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
          </label>
          <label className="block">
            <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Proceeds</span>
            <input type="number" min="0" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200" />
          </label>
          {proceedsNumber > 0 ? (
            <label className="block sm:col-span-2">
              <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Proceeds received into</span>
              <select value={proceedsAccountId} onChange={(e) => setProceedsAccountId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
                <option value="">Select…</option>
                {assetAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="block sm:col-span-2">
            <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Gain / loss on disposal account</span>
            <select value={gainLossAccountId} onChange={(e) => setGainLossAccountId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200">
              <option value="">Select…</option>
              {otherIncomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select>
          </label>
        </div>

        <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <p className="flex justify-between text-slate-600"><span>Net book value</span><span className="tabular-nums text-navy-950">{formatLedgerMoney(asset.netBookValue)}</span></p>
          <p className="flex justify-between text-slate-600"><span>Proceeds</span><span className="tabular-nums text-navy-950">{formatLedgerMoney(proceedsNumber)}</span></p>
          {preview.gain > 0 ? (
            <p className="flex justify-between font-semibold text-emerald-700"><span>Gain on disposal</span><span className="tabular-nums">{formatLedgerMoney(preview.gain)}</span></p>
          ) : preview.loss > 0 ? (
            <p className="flex justify-between font-semibold text-red-700"><span>Loss on disposal</span><span className="tabular-nums">{formatLedgerMoney(preview.loss)}</span></p>
          ) : (
            <p className="font-semibold text-slate-500">Disposes exactly at net book value — no gain or loss.</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
            Cancel
          </button>
          <button type="button" disabled={!canSubmit || submitting} onClick={() => void submit()}
            className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Confirm disposal
          </button>
        </div>
      </div>
    </div>
  );
}

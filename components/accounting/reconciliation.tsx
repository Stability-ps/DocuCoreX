"use client";

/**
 * Bank Reconciliation.
 *
 * The two balances are named separately everywhere they appear — "per bank
 * statement" and "per general ledger" — because the difference between them is
 * the subject of the exercise. A screen that called the statement figure "the
 * bank balance" would have answered the question before asking it.
 *
 * Completion is refused by the database unless the difference is EXPLAINED. The
 * UI shows the same arithmetic so the accountant sees why, but it is not the
 * control and never overrides one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  History,
  CheckCircle2,
  Landmark,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import {
  ITEM_TYPE_LABELS,
  confidenceLabel,
  isAccountingError,
  groupMatchStatus,
  reconciliationStatement,
  suggestMatches,
  type BankAccountSummary,
  type MatchSuggestion,
  type Reconciliation,
  type ReconciliationItem,
  type ReconciliationItemType,
  type UnmatchedBankItem,
  type UnmatchedLedgerEntry,
} from "@/lib/accounting/reconciliation";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

type Workspace = {
  reconciliation: Reconciliation;
  ledgerBalance: number;
  items: ReconciliationItem[];
  unmatchedBank: UnmatchedBankItem[];
  unmatchedLedger: UnmatchedLedgerEntry[];
};

export function BankReconciliation() {
  const period = useEntityPeriod();
  const [accounts, setAccounts] = useState<BankAccountSummary[]>([]);
  const [mappable, setMappable] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mapOpen, setMapOpen] = useState(false);
  const [history, setHistory] = useState<Array<{
    id: string; bankAccountLabel: string; periodStart: string; periodEnd: string;
    status: string; statementBalance: number | null; ledgerBalanceAtCompletion: number | null;
    difference: number | null; completedAt: string | null;
  }> | null>(null);

  const loadAccounts = useCallback(async (companyId: string, asAt: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/accounting/reconciliation?companyId=${encodeURIComponent(companyId)}&asAt=${asAt}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load bank accounts.");
      setAccounts(data.accounts ?? []);
      setMappable(data.mappableAccounts ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load bank accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId && !workspace) void loadAccounts(period.companyId, period.to);
  }, [period.companyId, period.to, workspace, loadAccounts]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/accounting/reconciliation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error ?? "Request failed.");
    return data;
  };

  const openWorkspace = async (bankAccountId: string) => {
    setBusy(true);
    setError("");
    try {
      const rec = await post({
        action: "start",
        companyId: period.companyId,
        bankAccountId,
        periodStart: period.from,
        periodEnd: period.to,
      });
      const response = await fetch(`/api/accounting/reconciliation?reconciliationId=${rec.id}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to open the reconciliation.");
      setWorkspace(data);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open the reconciliation.");
    } finally {
      setBusy(false);
    }
  };

  const refreshWorkspace = async (reconciliationId: string) => {
    const response = await fetch(`/api/accounting/reconciliation?reconciliationId=${reconciliationId}`);
    const data = await response.json();
    if (response.ok) setWorkspace(data);
  };

  if (workspace) {
    return (
      <ReconciliationWorkspace
        workspace={workspace}
        account={accounts.find((candidate) => candidate.id === workspace.reconciliation.bankAccountId) ?? null}
        companyId={period.companyId}
        busy={busy}
        error={error}
        setError={setError}
        setBusy={setBusy}
        post={post}
        refresh={() => refreshWorkspace(workspace.reconciliation.id)}
        onBack={() => {
          setWorkspace(null);
          void loadAccounts(period.companyId, period.to);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              if (history) { setHistory(null); return; }
              const response = await fetch(`/api/accounting/reconciliation?companyId=${encodeURIComponent(period.companyId)}&view=history`);
              const data = await response.json();
              if (response.ok) setHistory(data.history ?? []);
              else setError(data?.error ?? "Unable to load history.");
            }}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            {history ? "Hide history" : "View history"}
          </button>
          <button
            type="button"
            onClick={() => setMapOpen((open) => !open)}
            disabled={!mappable.length}
            title={mappable.length ? undefined : "This entity has no asset accounts to map to."}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Map bank account
          </button>
          </div>
        }
      />

      {mapOpen ? (
        <MapAccountForm
          companyId={period.companyId}
          mappable={mappable}
          onCancel={() => setMapOpen(false)}
          onDone={async () => {
            setMapOpen(false);
            await loadAccounts(period.companyId, period.to);
          }}
          post={post}
        />
      ) : null}

      {history ? (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Reconciliation history</h2>
            {history.length ? (
              <a
                href={`/api/accounting/reconciliation?companyId=${encodeURIComponent(period.companyId)}&view=history&format=csv`}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-royal-700 hover:underline"
              >
                <Download className="h-3 w-3" aria-hidden="true" />
                Export CSV
              </a>
            ) : null}
          </div>
          {!history.length ? (
            <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">
              No reconciliation has been started for this entity yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <caption className="sr-only">Past reconciliations</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left">
                    <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                    <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Period</th>
                    <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Per statement</th>
                    <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Per ledger</th>
                    <th scope="col" className="px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Difference</th>
                    <th scope="col" className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2 font-semibold text-navy-950">{row.bankAccountLabel}</td>
                      <td className="px-4 py-2 text-slate-600">
                        {formatLedgerDate(row.periodStart)} – {formatLedgerDate(row.periodEnd)}
                      </td>
                      {/* Recorded at completion, not recomputed: a later journal
                          must not silently rewrite a signed-off reconciliation. */}
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">
                        {row.statementBalance === null ? "—" : formatLedgerMoney(row.statementBalance)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">
                        {row.ledgerBalanceAtCompletion === null ? "—" : formatLedgerMoney(row.ledgerBalanceAtCompletion)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-navy-950">
                        {row.difference === null ? "—" : formatLedgerMoney(row.difference)}
                      </td>
                      <td className="px-4 py-2 text-xs font-semibold capitalize text-slate-600">
                        {row.status.replace("_", " ")}
                        {row.completedAt ? ` · ${formatLedgerDate(row.completedAt.slice(0, 10))}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {error || (!period.companyId && !period.loading) ? (
        // The !period.companyId case covers entity loading itself failing (or the
        // workspace having none) — loadAccounts() below never runs without a
        // companyId, so `error` alone would never surface that.
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error || period.error || "No accounting entities are set up for this workspace yet."}
        </p>
      ) : null}

      {period.loading || (loading && period.companyId) ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading bank accounts…
        </div>
      ) : !period.companyId ? null : !accounts.length ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
          <Landmark className="mx-auto h-10 w-10 text-slate-300" aria-hidden="true" />
          <h2 className="mt-4 text-base font-bold text-navy-950">No bank account is mapped yet</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm font-semibold text-slate-500">
            Reconciliation compares a bank statement against the ledger account the bank&apos;s transactions post to.
            Map the bank account to its control account in the chart — for example <strong>1100 Bank</strong> — and its
            balances appear here.
          </p>
          <p className="mx-auto mt-2 max-w-lg text-xs font-semibold text-slate-400">
            The mapping is stated rather than guessed from transaction descriptions, so the books never depend on how a
            statement happened to be worded.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <caption className="sr-only">Bank accounts and their reconciliation status</caption>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Control account</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Per bank statement</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Per general ledger</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Difference</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                  <th scope="col" className="px-4 py-2.5"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const difference =
                    account.statementBalance === null ? null : account.statementBalance - account.ledgerBalance;
                  return (
                    <tr key={account.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-2.5">
                        <p className="font-semibold text-navy-950">{account.label}</p>
                        <p className="text-xs font-semibold text-slate-500">
                          {[account.bankName, account.accountNumber].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {account.ledgerAccountCode} — {account.ledgerAccountName}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-navy-950">
                        {account.statementBalance === null ? (
                          <span className="text-xs font-semibold text-slate-400">No statement</span>
                        ) : (
                          formatLedgerMoney(account.statementBalance)
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-navy-950">
                        {formatLedgerMoney(account.ledgerBalance)}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${difference && Math.round(difference * 100) !== 0 ? "text-amber-800" : "text-navy-950"}`}>
                        {difference === null ? "—" : formatLedgerMoney(difference)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={account.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => void openWorkspace(account.id)}
                          disabled={busy}
                          className="inline-flex h-8 items-center rounded-lg bg-royal-600 px-3 text-xs font-bold text-white transition hover:bg-royal-700 disabled:bg-slate-300"
                        >
                          {account.status === "reconciled" ? "Review" : "Reconcile"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs font-semibold text-slate-500">
        &quot;Per bank statement&quot; is what the bank printed. &quot;Per general ledger&quot; is derived from posted
        accounting entries. They are different figures, and the difference between them is what a reconciliation
        explains.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: BankAccountSummary["status"] }) {
  const config = {
    reconciled: { label: "Reconciled", className: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2 },
    review: { label: "Review", className: "bg-amber-50 text-amber-800", Icon: AlertTriangle },
    no_statement: { label: "No statement", className: "bg-slate-100 text-slate-600", Icon: AlertTriangle },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${config.className}`}>
      <config.Icon className="h-3 w-3" aria-hidden="true" />
      {config.label}
    </span>
  );
}

function MapAccountForm({
  companyId,
  mappable,
  onCancel,
  onDone,
  post,
}: {
  companyId: string;
  mappable: Array<{ id: string; code: string; name: string }>;
  onCancel: () => void;
  onDone: () => Promise<void>;
  post: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [label, setLabel] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ledgerAccountId, setLedgerAccountId] = useState(mappable[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  return (
    <form
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setFormError("");
        try {
          await post({ action: "map-account", companyId, label, bankName, accountNumber, ledgerAccountId });
          await onDone();
        } catch (saveError) {
          setFormError(saveError instanceof Error ? saveError.message : "Unable to map the account.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2 className="text-sm font-bold text-navy-950">Map a bank account to its control account</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Label</span>
          <input
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Example: FNB Business Current"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-navy-950 placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Bank</span>
          <input
            value={bankName}
            onChange={(event) => setBankName(event.target.value)}
            placeholder="Example: FNB"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-navy-950 placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Account number</span>
          <input
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value)}
            placeholder="Example: 62905786151"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-navy-950 placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          />
        </label>
        <label className="block">
          <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Control account</span>
          <select
            value={ledgerAccountId}
            onChange={(event) => setLedgerAccountId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            {mappable.map((account) => (
              <option key={account.id} value={account.id}>{account.code} — {account.name}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs font-semibold text-slate-500">
        A bank name or an account number is required — statements are matched to this account by one of them.
      </p>
      {formError ? (
        <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{formError}</p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:bg-slate-300"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Save mapping
        </button>
        <button type="button" onClick={onCancel} className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-slate-500 hover:text-navy-950">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReconciliationWorkspace({
  workspace,
  account,
  companyId,
  busy,
  error,
  setError,
  setBusy,
  post,
  refresh,
  onBack,
}: {
  workspace: Workspace;
  account: BankAccountSummary | null;
  companyId: string;
  busy: boolean;
  error: string;
  setError: (value: string) => void;
  setBusy: (value: boolean) => void;
  post: (body: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
  onBack: () => void;
}) {
  const { reconciliation, ledgerBalance, items, unmatchedBank, unmatchedLedger } = workspace;
  const [statementBalance, setStatementBalance] = useState(
    account?.statementBalance !== null && account?.statementBalance !== undefined ? String(account.statementBalance) : "",
  );
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [selectedBank, setSelectedBank] = useState<string[]>([]);
  const [selectedLedger, setSelectedLedger] = useState<string[]>([]);

  const groupStatus = groupMatchStatus({
    bankAmounts: selectedBank.map((id) => unmatchedBank.find((item) => item.transactionId === id)?.amount ?? 0),
    ledgerAmounts: selectedLedger.map((id) => unmatchedLedger.find((entry) => entry.postingId === id)?.amount ?? 0),
  });

  const matchSelectedGroup = async () => {
    // One match_group id shared by every row, so the relationship survives as a
    // group rather than as unrelated pairs.
    const matchGroup = crypto.randomUUID();
    await act({
      action: "record-items",
      reconciliationId: reconciliation.id,
      companyId,
      entries: [
        ...selectedBank.map((id) => ({ transactionId: id, itemType: "matched", matchGroup, matchMethod: "manual" })),
        ...selectedLedger.map((id) => ({ postingId: id, itemType: "matched", matchGroup, matchMethod: "manual" })),
      ],
    });
    setSelectedBank([]);
    setSelectedLedger([]);
  };


  const reconciling = useMemo(() => {
    // Only timing differences and not-yet-on-statement items explain a
    // difference. A missing posting is an accounting error and is deliberately
    // excluded — the database refuses completion while one is unresolved.
    const bankSide = items
      .filter((item) => item.itemType === "timing_difference" || item.itemType === "missing_bank_item")
      .map((item) => unmatchedBank.find((bank) => bank.transactionId === item.transactionId)?.amount ?? 0);
    const ledgerSide = items
      .filter((item) => item.itemType === "timing_difference" || item.itemType === "missing_bank_item")
      .map((item) => unmatchedLedger.find((entry) => entry.postingId === item.postingId)?.amount ?? 0);
    return reconciliationStatement({
      statementBalance: Number.parseFloat(statementBalance) || 0,
      ledgerBalance,
      bankSideItems: bankSide,
      ledgerSideItems: ledgerSide,
    });
  }, [items, unmatchedBank, unmatchedLedger, statementBalance, ledgerBalance]);

  const unresolvedErrors = items.filter((item) => isAccountingError(item.itemType) && !item.resolvingJournalId).length;
  const completed = reconciliation.status === "completed";

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      await post(body);
      await refresh();
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-bold text-royal-700 hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          All bank accounts
        </button>
        <p className="text-sm font-semibold text-slate-500">
          {account?.label ?? "Bank account"} · {formatLedgerDate(reconciliation.periodStart)} – {formatLedgerDate(reconciliation.periodEnd)}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Balance per bank statement</dt>
            <dd className="mt-1">
              {completed ? (
                <span className="text-lg font-semibold tabular-nums text-navy-950">
                  {formatLedgerMoney(reconciliation.statementBalance ?? 0)}
                </span>
              ) : (
                <input
                  inputMode="decimal"
                  value={statementBalance}
                  onChange={(event) => setStatementBalance(event.target.value)}
                  aria-label="Balance per bank statement"
                  className="w-40 rounded-lg border border-slate-300 px-3 py-1.5 text-right text-sm tabular-nums text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
                />
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Balance per general ledger</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-navy-950">{formatLedgerMoney(ledgerBalance)}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Reconciling items</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-navy-950">
              {formatLedgerMoney(reconciling.bankSide - reconciling.ledgerSide)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Unexplained</dt>
            <dd className={`mt-1 text-lg font-semibold tabular-nums ${reconciling.explained ? "text-emerald-700" : "text-amber-800"}`}>
              {formatLedgerMoney(reconciling.unexplained)}
            </dd>
          </div>
        </dl>

        {unresolvedErrors > 0 ? (
          <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {unresolvedErrors} {unresolvedErrors === 1 ? "item is" : "items are"} on the statement but missing from the
            ledger. That is an accounting error, not a reconciling item — post a journal for each before completing.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || completed || !unmatchedBank.length || !unmatchedLedger.length}
            onClick={() => setSuggestions(suggestMatches(unmatchedBank, unmatchedLedger))}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Suggest matches
          </button>
          <button
            type="button"
            disabled={busy || completed}
            onClick={() =>
              void act({
                action: "complete",
                reconciliationId: reconciliation.id,
                statementBalance: Number.parseFloat(statementBalance) || 0,
              })
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:bg-slate-300"
          >
            Complete Reconciliation
          </button>
          {completed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "reopen", reconciliationId: reconciliation.id })}
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
            >
              Reopen
            </button>
          ) : null}
        </div>

        {completed ? (
          <p className="mt-3 flex items-center gap-2 text-sm font-bold text-emerald-700">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Completed{reconciliation.completedAt ? ` on ${formatLedgerDate(reconciliation.completedAt.slice(0, 10))}` : ""}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}

      {suggestions.length ? (
        <section className="rounded-2xl border border-royal-200 bg-royal-50/40 p-4">
          <h2 className="text-sm font-bold text-navy-950">Suggested matches</h2>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">
            Suggestions only. Nothing is matched until you confirm it.
          </p>
          <ul className="mt-3 space-y-2">
            {suggestions.map((suggestion) => {
              const bankItem = unmatchedBank.find((item) => item.transactionId === suggestion.transactionId);
              const ledgerEntry = unmatchedLedger.find((entry) => entry.postingId === suggestion.postingId);
              if (!bankItem || !ledgerEntry) return null;
              return (
                <li key={`${suggestion.transactionId}-${suggestion.postingId}`} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold text-navy-950">
                        {formatLedgerDate(bankItem.date)} · {bankItem.description}
                      </p>
                      <p className="text-slate-500">
                        matches {ledgerEntry.journalReference ?? "ledger entry"} · {formatLedgerMoney(ledgerEntry.amount)}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-slate-400">{suggestion.reasons.join(" · ")}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">
                        {confidenceLabel(suggestion.confidence)} confidence
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act({
                            action: "record-items",
                            reconciliationId: reconciliation.id,
                            companyId,
                            entries: [
                              { transactionId: suggestion.transactionId, itemType: "matched", matchMethod: "auto", matchConfidence: suggestion.confidence },
                              { postingId: suggestion.postingId, itemType: "matched", matchMethod: "auto", matchConfidence: suggestion.confidence },
                            ],
                          }).then(() => setSuggestions((current) => current.filter((entry) => entry !== suggestion)))
                        }
                        className="inline-flex h-8 items-center rounded-lg bg-royal-600 px-3 text-xs font-bold text-white hover:bg-royal-700 disabled:bg-slate-300"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setSuggestions((current) => current.filter((entry) => entry !== suggestion))}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-navy-950"
                        aria-label="Reject suggestion"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {selectedBank.length || selectedLedger.length ? (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 shadow-sm ${
            groupStatus.canMatch ? "border-emerald-300 bg-emerald-50/60" : "border-slate-200 bg-white"
          }`}
          aria-live="polite"
        >
          <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <div>
              <dt className="inline text-xs font-bold uppercase tracking-wide text-slate-500">Bank </dt>
              <dd className="inline font-semibold tabular-nums text-navy-950">{formatLedgerMoney(groupStatus.bankTotal)}</dd>
            </div>
            <div>
              <dt className="inline text-xs font-bold uppercase tracking-wide text-slate-500">Ledger </dt>
              <dd className="inline font-semibold tabular-nums text-navy-950">{formatLedgerMoney(groupStatus.ledgerTotal)}</dd>
            </div>
            <div>
              <dt className="inline text-xs font-bold uppercase tracking-wide text-slate-500">Difference </dt>
              <dd className={`inline font-semibold tabular-nums ${groupStatus.canMatch ? "text-emerald-700" : "text-amber-800"}`}>
                {formatLedgerMoney(groupStatus.difference)}
              </dd>
            </div>
          </dl>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-slate-600">{groupStatus.reason}</p>
            <button
              type="button"
              disabled={!groupStatus.canMatch || busy || completed}
              onClick={() => void matchSelectedGroup()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:bg-slate-300"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Match selected
            </button>
            <button
              type="button"
              onClick={() => { setSelectedBank([]); setSelectedLedger([]); }}
              className="text-xs font-bold text-slate-500 hover:text-navy-950"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <UnmatchedPanel
          title="Unmatched bank items"
          caption="On the statement, not yet matched to the ledger"
          empty="Every bank item is accounted for."
          selected={selectedBank}
          onToggle={(key) =>
            setSelectedBank((current) => (current.includes(key) ? current.filter((id) => id !== key) : [...current, key]))
          }
          rows={unmatchedBank.map((item) => ({
            key: item.transactionId,
            date: item.date,
            text: item.description,
            amount: item.amount,
            onType: (type: ReconciliationItemType) =>
              act({
                action: "record-items",
                reconciliationId: reconciliation.id,
                companyId,
                entries: [{ transactionId: item.transactionId, itemType: type }],
              }),
          }))}
          disabled={busy || completed}
        />
        <UnmatchedPanel
          title="Unmatched ledger entries"
          caption="Posted to the control account, not yet matched to the statement"
          empty="Every ledger entry is accounted for."
          selected={selectedLedger}
          onToggle={(key) =>
            setSelectedLedger((current) => (current.includes(key) ? current.filter((id) => id !== key) : [...current, key]))
          }
          rows={unmatchedLedger.map((entry) => ({
            key: entry.postingId,
            date: entry.date,
            text: entry.description ?? entry.journalReference ?? "Ledger entry",
            amount: entry.amount,
            onType: (type: ReconciliationItemType) =>
              act({
                action: "record-items",
                reconciliationId: reconciliation.id,
                companyId,
                entries: [{ postingId: entry.postingId, itemType: type }],
              }),
          }))}
          disabled={busy || completed}
          ledgerSide
        />
      </div>

      {items.length ? (
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">
            Reconciliation items ({items.length})
          </h2>
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="flex items-center gap-2">
                  {isAccountingError(item.itemType) && !item.resolvingJournalId ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                  )}
                  <span className="font-semibold text-navy-950">{ITEM_TYPE_LABELS[item.itemType]}</span>
                  {item.matchConfidence !== null ? (
                    <span className="text-xs font-semibold text-slate-400">
                      {confidenceLabel(item.matchConfidence)} confidence, confirmed
                    </span>
                  ) : null}
                </span>
                {!completed ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act({ action: "remove-item", itemId: item.id })}
                    className="text-xs font-bold text-slate-500 hover:text-red-700"
                  >
                    Unmatch
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs font-semibold text-slate-500">
        A reconciliation completes when the difference is <strong>explained</strong>: statement balance, less bank items
        not yet in the books, plus ledger entries not yet at the bank, equals the ledger balance. A zero difference
        reached any other way is refused.{" "}
        <Link href="/accounting/journals" className="text-royal-700 underline">Post a journal</Link> for anything the
        ledger is missing.
      </p>
    </div>
  );
}

function UnmatchedPanel({
  title,
  caption,
  empty,
  rows,
  disabled,
  ledgerSide = false,
  selected,
  onToggle,
}: {
  title: string;
  caption: string;
  empty: string;
  rows: Array<{ key: string; date: string; text: string; amount: number; onType: (type: ReconciliationItemType) => void }>;
  disabled: boolean;
  ledgerSide?: boolean;
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">{title} ({rows.length})</h2>
        <p className="text-xs font-semibold text-slate-400">{caption}</p>
      </div>
      {!rows.length ? (
        <p className="px-4 py-8 text-center text-sm font-semibold text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.key} className="px-4 py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(row.key)}
                    onChange={() => onToggle(row.key)}
                    disabled={disabled}
                    aria-label={`Select ${row.text}`}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-navy-950">{row.text}</p>
                    <p className="text-xs font-semibold text-slate-500">{formatLedgerDate(row.date)}</p>
                  </div>
                </div>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-navy-950">{formatLedgerMoney(row.amount)}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <TypeButton disabled={disabled} onClick={() => row.onType("timing_difference")}>Timing difference</TypeButton>
                {/* The distinction §7 turns on: a timing difference resolves
                    itself; this one means the books are wrong. */}
                <TypeButton
                  disabled={disabled}
                  tone="warn"
                  onClick={() => row.onType(ledgerSide ? "missing_bank_item" : "missing_posting")}
                >
                  {ledgerSide ? "Not yet at the bank" : "Missing from ledger"}
                </TypeButton>
                <TypeButton disabled={disabled} onClick={() => row.onType("excluded")}>Exclude</TypeButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TypeButton({
  children,
  onClick,
  disabled,
  tone = "neutral",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  tone?: "neutral" | "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-2 py-1 text-xs font-bold transition disabled:opacity-40 ${
        tone === "warn"
          ? "border-amber-300 text-amber-800 hover:bg-amber-50"
          : "border-slate-300 text-slate-600 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

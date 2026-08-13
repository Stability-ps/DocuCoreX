"use client";

/**
 * Journals.
 *
 * The form is where double entry becomes something a person does rather than
 * something a schema describes. Its one job beyond capture: never let the
 * accountant reach the Post button believing a journal is right when it is not.
 *
 * The running Debit / Credit / Difference totals are the whole design. An
 * accountant reads the difference, not an error message — so it is present from
 * the first keystroke, and Post is disabled while it is non-zero. The database
 * refuses an unbalanced journal regardless; this is so it never gets that far.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Building2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AccountingEntity, LedgerAccount } from "@/lib/accounting/chart";
import { validateJournalLines, type JournalSummary, type JournalType } from "@/lib/accounting/journals";

const JOURNAL_TYPE_LABELS: Record<JournalType, string> = {
  general: "General Journal",
  adjustment: "Adjustment Journal",
  opening_balance: "Opening Balance Journal",
  depreciation: "Depreciation Journal",
  accrual: "Accrual Journal",
  prepayment: "Prepayment Journal",
  tax: "Tax Journal",
  closing: "Closing Journal",
  reversal: "Reversal Journal",
};

type DraftLine = { accountId: string; debit: string; credit: string; description: string };

const emptyLine = (): DraftLine => ({ accountId: "", debit: "", credit: "", description: "" });

/** Blank means zero; anything unparseable stays 0 rather than becoming NaN. */
function amount(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): string {
  return value.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function Journals() {
  const [entities, setEntities] = useState<AccountingEntity[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [journals, setJournals] = useState<JournalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);

  const [journalType, setJournalType] = useState<JournalType>("general");
  const [reference, setReference] = useState("");
  const [journalDate, setJournalDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const loadEntities = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/accounting/chart-of-accounts");
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to load entities.");
      const list: AccountingEntity[] = data.entities ?? [];
      setEntities(list);
      const preferred = list.find((entity) => entity.isDefault) ?? list[0];
      if (preferred) setCompanyId(preferred.id);
      else setLoading(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load entities.");
      setLoading(false);
    }
  }, []);

  const loadForCompany = useCallback(async (target: string) => {
    setLoading(true);
    setError("");
    try {
      const [chartResponse, journalsResponse] = await Promise.all([
        fetch(`/api/accounting/chart-of-accounts?companyId=${encodeURIComponent(target)}`),
        fetch(`/api/accounting/journals?companyId=${encodeURIComponent(target)}`),
      ]);
      const chartData = await chartResponse.json();
      const journalsData = await journalsResponse.json();
      if (!chartResponse.ok) throw new Error(chartData?.error ?? "Unable to load the chart of accounts.");
      if (!journalsResponse.ok) throw new Error(journalsData?.error ?? "Unable to load journals.");
      setAccounts((chartData.accounts ?? []).filter((account: LedgerAccount) => account.isActive));
      setJournals(journalsData.journals ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load journals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  useEffect(() => {
    if (companyId) void loadForCompany(companyId);
  }, [companyId, loadForCompany]);

  const parsedLines = useMemo(
    () => lines.map((line) => ({ accountId: line.accountId, debit: amount(line.debit), credit: amount(line.credit), description: line.description })),
    [lines],
  );

  const totals = useMemo(() => {
    // Summed in cents for the same reason the rules are: 0.1 + 0.2 is not 0.3
    // in binary floating point, and a difference of 5.6e-17 must never be
    // displayed as a real imbalance.
    const debit = parsedLines.reduce((total, line) => total + Math.round(line.debit * 100), 0);
    const credit = parsedLines.reduce((total, line) => total + Math.round(line.credit * 100), 0);
    return { debit: debit / 100, credit: credit / 100, difference: (debit - credit) / 100 };
  }, [parsedLines]);

  const issues = useMemo(() => validateJournalLines(parsedLines), [parsedLines]);
  const canPost = issues.length === 0 && !submitting;

  const submit = async (post: boolean) => {
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await fetch("/api/accounting/journals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, journalType, reference, journalDate, description, lines: parsedLines, post }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to save the journal.");

      setFormOpen(false);
      setLines([emptyLine(), emptyLine()]);
      setReference("");
      setDescription("");
      await loadForCompany(companyId);
    } catch (saveError) {
      setSubmitError(saveError instanceof Error ? saveError.message : "Unable to save the journal.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !entities.length) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading journals…
      </div>
    );
  }

  if (error && !entities.length) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm font-semibold text-red-800">{error}</p>
        <button
          type="button"
          onClick={() => void loadEntities()}
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
          A journal is posted against an entity. Add a company profile in Settings first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor="journal-entity" className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            Entity
          </label>
          <select
            id="journal-entity"
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
          >
            {entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.name}{entity.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
        {!formOpen ? (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            disabled={!accounts.length}
            title={accounts.length ? undefined : "This entity has no accounts to post to."}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700 disabled:bg-slate-300"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Journal
          </button>
        ) : null}
      </div>

      {formOpen ? (
        <form
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Journal date" htmlFor="journal-date">
              <input
                id="journal-date"
                type="date"
                required
                value={journalDate}
                onChange={(event) => setJournalDate(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
              />
            </Field>
            <Field label="Type" htmlFor="journal-type">
              <select
                id="journal-type"
                value={journalType}
                onChange={(event) => setJournalType(event.target.value as JournalType)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
              >
                {(Object.keys(JOURNAL_TYPE_LABELS) as JournalType[])
                  .filter((type) => type !== "reversal")
                  .map((type) => (
                    <option key={type} value={type}>{JOURNAL_TYPE_LABELS[type]}</option>
                  ))}
              </select>
            </Field>
            <Field label="Reference" htmlFor="journal-reference">
              <input
                id="journal-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Example: DEP-2026-001"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 placeholder:font-medium placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
              />
            </Field>
            <Field label="Description" htmlFor="journal-description">
              <input
                id="journal-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Example: Annual depreciation adjustment"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-navy-950 placeholder:font-medium placeholder:text-slate-400 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
              />
            </Field>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left">
                  <th scope="col" className="pb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
                  <th scope="col" className="pb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Line description</th>
                  <th scope="col" className="pb-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Debit</th>
                  <th scope="col" className="pb-2 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Credit</th>
                  <th scope="col" className="pb-2"><span className="sr-only">Remove line</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index} className="border-b border-slate-100">
                    <td className="py-2 pr-2">
                      <select
                        aria-label={`Line ${index + 1} account`}
                        value={line.accountId}
                        onChange={(event) =>
                          setLines((current) => current.map((item, i) => (i === index ? { ...item, accountId: event.target.value } : item)))
                        }
                        className="w-full min-w-[12rem] rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
                      >
                        <option value="">Select an account</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} — {account.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        aria-label={`Line ${index + 1} description`}
                        value={line.description}
                        onChange={(event) =>
                          setLines((current) => current.map((item, i) => (i === index ? { ...item, description: event.target.value } : item)))
                        }
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
                      />
                    </td>
                    {(["debit", "credit"] as const).map((side) => (
                      <td key={side} className="py-2 pr-2">
                        <input
                          aria-label={`Line ${index + 1} ${side}`}
                          inputMode="decimal"
                          value={line[side]}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((item, i) =>
                                i === index
                                  ? // Typing in one column clears the other: a line
                                    // is one side, and the schema refuses both.
                                    { ...item, [side]: event.target.value, [side === "debit" ? "credit" : "debit"]: "" }
                                  : item,
                              ),
                            )
                          }
                          className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-sm tabular-nums text-navy-950 focus:border-royal-500 focus:outline-none focus:ring-2 focus:ring-royal-200"
                        />
                      </td>
                    ))}
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => setLines((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current))}
                        disabled={lines.length <= 1}
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        aria-label={`Remove line ${index + 1}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-bold">
                  <td className="pt-2 text-xs uppercase tracking-wide text-slate-500" colSpan={2}>Total</td>
                  <td className="pt-2 text-right tabular-nums text-navy-950">{money(totals.debit)}</td>
                  <td className="pt-2 text-right tabular-nums text-navy-950">{money(totals.credit)}</td>
                  <td />
                </tr>
                <tr>
                  <td className="pt-1 text-xs uppercase tracking-wide text-slate-500" colSpan={2}>Difference</td>
                  <td
                    colSpan={2}
                    className={`pt-1 text-right tabular-nums font-bold ${totals.difference === 0 ? "text-emerald-700" : "text-amber-700"}`}
                  >
                    {money(totals.difference)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <button
            type="button"
            onClick={() => setLines((current) => [...current, emptyLine()])}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-royal-700 hover:text-royal-800"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add line
          </button>

          {issues.length ? (
            <ul className="mt-4 space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3" aria-live="polite">
              {issues.map((issue, index) => (
                <li key={index} className="flex items-start gap-2 text-sm font-semibold text-amber-900">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {issue.line ? `Line ${issue.line}: ` : ""}{issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          {submitError ? (
            <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
              {submitError}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canPost}
              title={canPost ? undefined : "A journal must balance before it can be posted."}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700 disabled:bg-slate-300"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Post Journal
            </button>
            {/* A draft is allowed to be unbalanced — that is what a draft is for. */}
            <button
              type="button"
              onClick={() => void submit(false)}
              disabled={submitting}
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-navy-950 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Save Draft
            </button>
            <button
              type="button"
              onClick={() => { setFormOpen(false); setSubmitError(""); }}
              className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-slate-500 hover:text-navy-950"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error && entities.length ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}

      {!journals.length && !loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
          <h2 className="text-base font-bold text-navy-950">No journals have been posted yet</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm font-semibold text-slate-500">
            Journals record adjustments that do not originate directly from a bank transaction.
          </p>
          <pre className="mx-auto mt-4 w-fit rounded-xl bg-slate-50 px-5 py-3 text-left text-xs font-semibold leading-6 text-slate-600">
{`Annual depreciation

Dr  Depreciation Expense      120,000
Cr    Accumulated Depreciation        120,000`}
          </pre>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <caption className="sr-only">Journals for the selected entity</caption>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Reference</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Type</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Debit</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Credit</th>
                  <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Status</th>
                </tr>
              </thead>
              <tbody>
                {journals.map((journal) => (
                  <tr key={journal.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-2 tabular-nums text-navy-950">{journal.journalDate}</td>
                    <td className="px-4 py-2 font-semibold text-navy-950">{journal.reference ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-600">{JOURNAL_TYPE_LABELS[journal.journalType]}</td>
                    <td className="px-4 py-2 text-slate-600">{journal.description ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-navy-950">{money(journal.totalDebit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-navy-950">{money(journal.totalCredit)}</td>
                    <td className="px-4 py-2">
                      <span className="capitalize text-slate-700">{journal.status.replace("_", " ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-bold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

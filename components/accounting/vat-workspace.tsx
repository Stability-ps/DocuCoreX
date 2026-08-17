"use client";

/**
 * VAT, derived from the ledger.
 *
 * Every figure here is VAT that was POSTED — an amount entered against an
 * explicit tax code, sitting in a control account. None of it is estimated.
 *
 * The product also has a VAT Working Paper that estimates 15/115 over bank
 * statements. That is a different thing, it remains available, and this page
 * links to it by name rather than quietly merging the two. An accountant must
 * always be able to tell which of the two they are looking at.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, Loader2, Lock, RefreshCw } from "lucide-react";
import { formatLedgerMoney } from "@/lib/accounting/format";
import { formatLedgerDate } from "@/lib/accounting/ledger";
import {
  DIRECTION_LABELS,
  type VatPosition,
  type VatReadinessCheck,
  type VatRegisterRow,
  type VatSummaryRow,
} from "@/lib/accounting/vat";
import { EntityPeriodBar, useEntityPeriod } from "@/components/accounting/entity-period-bar";

type VatPayload = {
  rows: VatSummaryRow[];
  register: VatRegisterRow[];
  totalRegisterRows: number;
  taxCodes: Array<{ id: string; code: string; name: string; rate: number; direction: string; controlAccountMapped: boolean; vat201Box: string | null }>;
  period: { status: "submitted" | "locked"; declaredOutputVat: number | null; declaredInputVat: number | null } | null;
  position: VatPosition;
  readiness: { checks: VatReadinessCheck[]; ready: boolean };
};

export function VatWorkspace() {
  const period = useEntityPeriod();
  const [data, setData] = useState<VatPayload | null>(null);
  const [tab, setTab] = useState<"position" | "register" | "codes">("position");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (companyId: string, from: string, to: string) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ companyId, from, to });
      const response = await fetch(`/api/accounting/vat?${query}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "Unable to load VAT.");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load VAT.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period.companyId && period.from && period.to) void load(period.companyId, period.from, period.to);
  }, [period.companyId, period.from, period.to, load]);

  const exportHref = period.companyId
    ? `/api/accounting/vat?${new URLSearchParams({ companyId: period.companyId, from: period.from, to: period.to, format: "csv" })}`
    : "#";

  return (
    <div className="space-y-4">
      <EntityPeriodBar
        {...period}
        right={
          data?.register.length ? (
            <a
              href={exportHref}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-navy-950 transition hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export VAT schedule
            </a>
          ) : null
        }
      />

      {period.loading || (loading && period.companyId) ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-20 text-sm font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading VAT…
        </div>
      ) : !period.companyId ? (
        // period.companyId never resolved: load() only runs once companyId (and
        // dates) are set, so without this branch `loading` stayed true forever
        // and this stage was unreachable.
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-800">{period.error || "No accounting entities are set up for this workspace yet."}</p>
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-800">{error}</p>
          <button
            type="button"
            onClick={() => period.companyId && void load(period.companyId, period.from, period.to)}
            className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : !data ? null : !data.rows.length ? (
        <EmptyVat />
      ) : (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <dl className="flex flex-wrap gap-x-10 gap-y-3">
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Output VAT</dt>
                  <dd className="text-lg font-semibold tabular-nums text-navy-950">{formatLedgerMoney(data.position.outputVat)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Input VAT</dt>
                  <dd className="text-lg font-semibold tabular-nums text-navy-950">{formatLedgerMoney(data.position.inputVat)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">
                    {data.position.payable ? "Net VAT payable" : "Net VAT refundable"}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums text-navy-950">
                    {formatLedgerMoney(Math.abs(data.position.netVat))}
                  </dd>
                </div>
              </dl>
              {data.period?.status === "locked" ? (
                <p className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  Filed and locked
                </p>
              ) : null}
            </div>

            {/* §16: a return is not presented as ready until the checks pass. */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h2 className="text-xs font-bold uppercase tracking-wide text-slate-500">Before filing</h2>
              <ul className="mt-2 space-y-1">
                {data.readiness.checks.map((check) => (
                  <li key={check.label} className="flex items-start gap-2 text-sm font-semibold">
                    {check.state === "ok" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                    )}
                    <span className="sr-only">{check.state === "ok" ? "Passed:" : "Needs attention:"}</span>
                    <span className={check.state === "ok" ? "text-slate-700" : "text-amber-900"}>
                      {check.label}
                      {check.detail ? <span className="font-medium text-slate-500"> — {check.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={`mt-3 text-sm font-bold ${data.readiness.ready ? "text-emerald-700" : "text-amber-800"}`}>
                {data.readiness.ready
                  ? "These figures are ready to prepare a return from."
                  : "These figures are not ready to file from until the items above are resolved."}
              </p>
            </div>

            {data.period?.declaredOutputVat !== null && data.period?.declaredOutputVat !== undefined ? (
              <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs font-semibold text-slate-600">
                A return was filed for this period declaring output {formatLedgerMoney(data.period.declaredOutputVat)} and
                input {formatLedgerMoney(data.period.declaredInputVat ?? 0)}. Any difference against the figures above is a
                change made to the ledger after filing.
              </p>
            ) : null}
          </section>

          <div className="flex gap-1 border-b border-slate-200">
            {([
              ["position", "VAT position"],
              ["register", `Register (${data.totalRegisterRows})`],
              ["codes", `Tax codes (${data.taxCodes.length})`],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`border-b-2 px-3 py-2 text-sm font-semibold transition ${
                  tab === id ? "border-royal-600 text-royal-700" : "border-transparent text-slate-500 hover:text-navy-950"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "position" ? <PositionTable rows={data.rows} /> : null}
          {tab === "register" ? <RegisterTable rows={data.register} /> : null}
          {tab === "codes" ? <CodesTable codes={data.taxCodes} /> : null}
        </>
      )}

      <p className="text-xs font-semibold text-slate-500">
        These figures are VAT that was <strong>posted</strong> to the ledger against an explicit tax code. The product
        also produces a{" "}
        <Link href="/accounting/bank-statements" className="text-royal-700 underline">
          VAT working paper estimated from bank statements
        </Link>
        , which is a different calculation over source data. The two will differ; neither is a substitute for the other.
      </p>
    </div>
  );
}

function PositionTable({ rows }: { rows: VatSummaryRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] border-collapse text-sm">
          <caption className="sr-only">VAT by tax code</caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Code</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Treatment</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">VAT201</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Taxable value</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">VAT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.taxCodeId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                <td className="px-4 py-2 font-semibold text-navy-950">
                  {row.code}
                  {row.isCapital ? <span className="ml-2 text-xs font-bold text-slate-400">capital</span> : null}
                </td>
                <td className="px-4 py-2 text-slate-600">
                  {row.name}
                  <span className="ml-2 text-xs font-semibold text-slate-400">{DIRECTION_LABELS[row.direction]}</span>
                </td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{row.vat201Box ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.netAmount)}</td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums text-navy-950">
                  {row.controlAccountMapped ? (
                    formatLedgerMoney(row.vatAmount)
                  ) : (
                    // Not zero: this code's VAT has nowhere to be located, and
                    // showing R0.00 would assert that none arose.
                    <span className="text-xs font-semibold text-amber-700">No control account</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RegisterTable({ rows }: { rows: VatRegisterRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <caption className="sr-only">VAT register — every VAT-bearing posting</caption>
          <thead className="sticky top-0 bg-slate-50">
            <tr className="border-b border-slate-200 text-left">
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Date</th>
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Code</th>
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Account</th>
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Description</th>
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Reference</th>
              <th scope="col" className="px-3 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Amount</th>
              <th scope="col" className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Leg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.postingId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-navy-950">{formatLedgerDate(row.postingDate)}</td>
                <td className="px-3 py-2 font-semibold text-navy-950">{row.code}</td>
                <td className="px-3 py-2 text-slate-600">{row.accountCode} — {row.accountName}</td>
                <td className="px-3 py-2 text-slate-600">{row.description ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600">{row.journalReference ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-navy-950">{formatLedgerMoney(row.amount)}</td>
                <td className="px-3 py-2 text-xs font-semibold text-slate-500">
                  {row.isControlLeg ? "VAT" : "Taxable value"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CodesTable({
  codes,
}: {
  codes: Array<{ id: string; code: string; name: string; rate: number; direction: string; controlAccountMapped: boolean; vat201Box: string | null }>;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-sm">
          <caption className="sr-only">Tax codes for this entity</caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left">
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Code</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Name</th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-bold uppercase tracking-wide text-slate-500">Rate</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Direction</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">VAT201</th>
              <th scope="col" className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Control account</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <tr key={code.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-semibold text-navy-950">{code.code}</td>
                <td className="px-4 py-2 text-slate-600">{code.name}</td>
                <td className="px-4 py-2 text-right tabular-nums text-navy-950">{code.rate.toFixed(2)}%</td>
                <td className="px-4 py-2 text-slate-600">{DIRECTION_LABELS[code.direction as keyof typeof DIRECTION_LABELS]}</td>
                <td className="px-4 py-2 tabular-nums text-slate-600">{code.vat201Box ?? "—"}</td>
                <td className="px-4 py-2">
                  {code.direction === "none" ? (
                    <span className="text-xs font-semibold text-slate-400">Not required</span>
                  ) : code.controlAccountMapped ? (
                    <span className="text-xs font-semibold text-emerald-700">Mapped</span>
                  ) : (
                    <span className="text-xs font-semibold text-amber-700">Not mapped</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyVat() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <h2 className="text-base font-bold text-navy-950">No VAT has been posted in this period</h2>
      <p className="mx-auto mt-1 max-w-xl text-sm font-semibold text-slate-500">
        VAT here is the amount posted to a control account against an explicit tax code — for example:
      </p>
      <pre className="mx-auto mt-4 w-fit rounded-xl bg-slate-50 px-5 py-3 text-left text-xs font-semibold leading-6 text-slate-600">
{`Dr  Repairs & Maintenance     869.57   STD-IN
Dr  VAT Control               130.43   STD-IN
Cr    Bank                            1,000.00`}
      </pre>
      <p className="mx-auto mt-3 max-w-xl text-xs font-semibold text-slate-500">
        Historic transactions carry a VAT label from the extraction classifier. Those are deliberately not treated as tax
        determinations — assign a tax code when posting, and the figures appear here.
      </p>
      <Link
        href="/accounting/journals"
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-royal-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-royal-700"
      >
        View Journals
      </Link>
    </div>
  );
}

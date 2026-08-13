import type { Metadata } from "next";
import { AuditTrail } from "@/components/accounting/audit-trail";

export const metadata: Metadata = { title: "Audit Trail" };

export default function AuditTrailPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Audit Trail
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Audit Trail</h1>
        <p className="text-sm font-semibold text-slate-500">
          Every posting, period close, reconciliation and VAT event, recorded by the database itself.
        </p>
      </header>
      <AuditTrail />
    </div>
  );
}

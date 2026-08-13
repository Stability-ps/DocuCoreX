import type { Metadata } from "next";
import { AccountingOverview } from "@/components/accounting/accounting-overview";

export const metadata: Metadata = { title: "Accounting & Financial Reporting" };

// /accounting is the Overview. Bank Statements — what this route used to render
// — moved to /accounting/bank-statements, so that section is now linkable in its
// own right rather than being whichever tab the component happened to open on.
export default function AccountingPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Overview
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">
          Accounting &amp; Financial Reporting
        </h1>
        <p className="text-sm font-semibold text-slate-500">
          Are the records complete, reconciled, and ready for reporting?
        </p>
      </header>
      <AccountingOverview />
    </div>
  );
}

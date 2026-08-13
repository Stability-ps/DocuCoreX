import type { Metadata } from "next";
import { TrialBalance } from "@/components/accounting/trial-balance";

export const metadata: Metadata = { title: "Trial Balance" };

export default function TrialBalancePage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Trial Balance
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Trial Balance</h1>
        <p className="text-sm font-semibold text-slate-500">Posted ledger entries, aggregated by account.</p>
      </header>
      <TrialBalance />
    </div>
  );
}

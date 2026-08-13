import type { Metadata } from "next";
import { BankReconciliation } from "@/components/accounting/reconciliation";

export const metadata: Metadata = { title: "Bank Reconciliation" };

export default function ReconciliationPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Bank Reconciliation
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Bank Reconciliation</h1>
        <p className="text-sm font-semibold text-slate-500">
          Balance per bank statement against balance per general ledger.
        </p>
      </header>
      <BankReconciliation />
    </div>
  );
}

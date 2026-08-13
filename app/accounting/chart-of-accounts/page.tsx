import type { Metadata } from "next";
import { ChartOfAccounts } from "@/components/accounting/chart-of-accounts";

export const metadata: Metadata = { title: "Chart of Accounts" };

export default function ChartOfAccountsPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Chart of Accounts
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Chart of Accounts</h1>
        <p className="text-sm font-semibold text-slate-500">
          The accounts this entity&apos;s books are kept in.
        </p>
      </header>
      <ChartOfAccounts />
    </div>
  );
}

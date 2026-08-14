import type { Metadata } from "next";
import { Payables } from "@/components/accounting/receivables-payables";

export const metadata: Metadata = { title: "Accounts Payable" };

export default function PayablesPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Accounts Payable
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Accounts Payable</h1>
        <p className="text-sm font-semibold text-slate-500">
          Who is owed what, and how much of it has already been paid.
        </p>
      </header>
      <Payables />
    </div>
  );
}

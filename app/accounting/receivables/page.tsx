import type { Metadata } from "next";
import { Receivables } from "@/components/accounting/receivables-payables";

export const metadata: Metadata = { title: "Accounts Receivable" };

export default function ReceivablesPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Accounts Receivable
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Accounts Receivable</h1>
        <p className="text-sm font-semibold text-slate-500">
          Who owes what, and how much of it has already been collected.
        </p>
      </header>
      <Receivables />
    </div>
  );
}

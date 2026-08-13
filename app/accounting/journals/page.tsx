import type { Metadata } from "next";
import { Journals } from "@/components/accounting/journals";

export const metadata: Metadata = { title: "Journals" };

export default function JournalsPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Journals
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Journals</h1>
        <p className="text-sm font-semibold text-slate-500">
          Adjustments that do not originate directly from a bank transaction.
        </p>
      </header>
      <Journals />
    </div>
  );
}

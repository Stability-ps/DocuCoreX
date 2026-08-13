import type { Metadata } from "next";
import { PeriodClose } from "@/components/accounting/period-close";

export const metadata: Metadata = { title: "Period Close" };

export default function PeriodClosePage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Period Close
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Period Close</h1>
        <p className="text-sm font-semibold text-slate-500">
          Soft-close or lock a period. A locked period refuses new postings until it is reopened.
        </p>
      </header>
      <PeriodClose />
    </div>
  );
}

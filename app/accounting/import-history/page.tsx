import type { Metadata } from "next";
import { ImportHistory } from "@/components/accounting/import-history";

export const metadata: Metadata = { title: "Import History" };

export default function ImportHistoryPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Import History
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Import History</h1>
        <p className="text-sm font-semibold text-slate-500">
          Every chart-of-accounts and journal import, and the error report for anything it rejected.
        </p>
      </header>
      <ImportHistory />
    </div>
  );
}

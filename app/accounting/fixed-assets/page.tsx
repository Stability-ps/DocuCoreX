import type { Metadata } from "next";
import { FixedAssets } from "@/components/accounting/fixed-assets";

export const metadata: Metadata = { title: "Fixed Assets" };

export default function FixedAssetsPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> Fixed Assets
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">Fixed Assets</h1>
        <p className="text-sm font-semibold text-slate-500">
          A register of cost and dates, with accumulated depreciation and net book value derived from the ledger.
        </p>
      </header>
      <FixedAssets />
    </div>
  );
}

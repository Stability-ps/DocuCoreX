import type { Metadata } from "next";
import { VatWorkspace } from "@/components/accounting/vat-workspace";

export const metadata: Metadata = { title: "VAT" };

// VAT derived from the ledger. The statement-based estimate is not removed —
// it moved to /accounting/vat/statement-estimate and is linked from here, so an
// accountant can always tell which of the two figures they are looking at.
export default function VatPage() {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> VAT
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">VAT</h1>
        <p className="text-sm font-semibold text-slate-500">Output and input VAT posted to the ledger.</p>
      </header>
      <VatWorkspace />
    </div>
  );
}

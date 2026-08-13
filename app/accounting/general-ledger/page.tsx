import type { Metadata } from "next";
import { GeneralLedger } from "@/components/accounting/general-ledger";

export const metadata: Metadata = { title: "General Ledger" };

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  // The Trial Balance links here with an account preselected, so a balance
  // drills into the entries that produced it rather than into an unfiltered
  // ledger the accountant then has to search.
  const { accountId } = await searchParams;

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-0.5 border-b border-slate-200 pb-3">
        <p className="hidden text-xs font-bold uppercase tracking-wide text-slate-500 md:block">
          Accounting &amp; Financial Reporting <span className="mx-1.5 text-slate-300">›</span> General Ledger
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-navy-950 sm:text-[22px]">General Ledger</h1>
        <p className="text-sm font-semibold text-slate-500">Every posted accounting entry, by account.</p>
      </header>
      <GeneralLedger initialAccountId={accountId} />
    </div>
  );
}

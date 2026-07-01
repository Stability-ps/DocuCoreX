import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";
import { PageHeader } from "@/components/ui";

export default function AccountingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Accounting Intelligence"
        title="FNB statement accounting engine"
        description="Upload FNB South Africa business bank statement PDFs, extract transactions, review accounting treatment and export a structured Excel workpaper."
      />
      <AccountingIntelligence />
    </>
  );
}

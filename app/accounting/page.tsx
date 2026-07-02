import { AccountingIntelligence } from "@/components/accounting/accounting-intelligence";
import { PageHeader } from "@/components/ui";

export default function AccountingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Accounting Intelligence"
        title="Accounting workspace for finance teams"
        description="Built for accountants, bookkeepers, auditors, tax practitioners and finance teams."
      />
      <AccountingIntelligence />
    </>
  );
}

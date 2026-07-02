import { InvoiceList } from "@/components/invoices/invoice-list";
import { PageHeader } from "@/components/ui";

export default function InvoicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Client invoicing"
        title="Invoices"
        description="Create client invoices, track line items and totals, and follow each invoice from draft through payment."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <InvoiceList />
      </div>
    </>
  );
}

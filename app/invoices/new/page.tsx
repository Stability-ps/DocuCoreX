import { InvoiceCreateForm } from "@/components/invoices/invoice-create-form";
import { PageHeader } from "@/components/ui";

export default function NewInvoicePage() {
  return (
    <>
      <PageHeader
        eyebrow="Client invoicing"
        title="Create invoice"
        description="Add client details and line items. Subtotal, VAT and the final total are calculated automatically."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <InvoiceCreateForm />
      </div>
    </>
  );
}

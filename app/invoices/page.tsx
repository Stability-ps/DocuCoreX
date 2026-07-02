import { InvoiceList } from "@/components/invoices/invoice-list";

// InvoiceList renders its own header (title, subtitle, "New invoice" button) so it stays
// visible on mobile too — the shared <PageHeader> primitive hides itself below the `md`
// breakpoint, which doesn't work for a page mobile users rely on constantly.
export default function InvoicesPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <InvoiceList />
    </div>
  );
}

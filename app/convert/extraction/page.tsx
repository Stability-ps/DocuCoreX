import { FileSearch } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function ExtractionPage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="Extraction"
      description="Detect document type automatically and extract structured fields for finance, audit and operations workflows."
      icon={FileSearch}
      status="Extraction modules ready"
      capabilities={["Bank statements", "Invoices and receipts", "Contracts, payslips and tax documents"]}
      actions={[
        { label: "Upload for Extraction", href: "/upload?workflow=extraction" },
        { label: "View Documents", href: "/documents" },
      ]}
    />
  );
}

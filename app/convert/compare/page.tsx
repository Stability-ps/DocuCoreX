import { Columns3 } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function ComparePage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="Compare"
      description="Compare document versions, statements, invoices or extracted datasets side by side."
      icon={Columns3}
      status="Comparison shell"
      capabilities={["Side-by-side review route", "Version comparison destination", "Data comparison workflow shell"]}
      actions={[{ label: "Open Version History", href: "/documents" }]}
    />
  );
}

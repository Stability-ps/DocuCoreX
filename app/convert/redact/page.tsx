import { PencilLine } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function RedactPage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="Redact"
      description="Prepare a secure redaction workflow for names, account numbers, IDs and sensitive fields."
      icon={PencilLine}
      status="Redaction shell"
      capabilities={["Sensitive-field route", "Permission-ready workflow", "Audit-ready redaction area"]}
      actions={[{ label: "Open Documents", href: "/documents" }]}
    />
  );
}

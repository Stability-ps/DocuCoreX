import { FolderArchive } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function ArchiveDocumentsPage() {
  return (
    <PlaceholderPage
      eyebrow="Documents"
      title="Archive"
      description="Long-term document retention for closed periods, completed audits and historical exports."
      icon={FolderArchive}
      status="Archive workflow ready"
      capabilities={["Archive policy area", "Retention-ready route", "Workspace-scoped document access"]}
      actions={[{ label: "View All Documents", href: "/documents" }]}
    />
  );
}

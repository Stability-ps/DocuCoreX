import { DocumentWorkspaceShell } from "@/components/documents/document-workspace-shell";
import { PageHeader } from "@/components/ui";

export default function ArchiveDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Archive"
        description="Archived documents kept out of the main workspace but retained for reference."
      />
      <DocumentWorkspaceShell initialFilter="archived" />
    </>
  );
}

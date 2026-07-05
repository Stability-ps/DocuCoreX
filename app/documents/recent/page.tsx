import { DocumentWorkspaceShell } from "@/components/documents/document-workspace-shell";
import { PageHeader } from "@/components/ui";

export default function RecentDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Recent documents"
        description="Your most recently updated documents, newest first."
      />
      <DocumentWorkspaceShell initialFilter="all" />
    </>
  );
}

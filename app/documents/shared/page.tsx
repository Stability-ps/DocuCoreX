import { DocumentWorkspaceShell } from "@/components/documents/document-workspace-shell";
import { PageHeader } from "@/components/ui";

export default function SharedDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Shared documents"
        description="Documents shared with teams, auditors, clients and external reviewers."
      />
      <DocumentWorkspaceShell initialFilter="shared" />
    </>
  );
}

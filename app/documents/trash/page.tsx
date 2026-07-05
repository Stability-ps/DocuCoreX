import { DocumentWorkspaceShell } from "@/components/documents/document-workspace-shell";
import { PageHeader } from "@/components/ui";

export default function TrashDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Trash"
        description="Restore deleted documents or permanently remove files you no longer need."
      />
      <DocumentWorkspaceShell initialFilter="trash" />
    </>
  );
}

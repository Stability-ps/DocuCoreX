import { DocumentWorkspaceShell } from "@/components/documents/document-workspace-shell";
import { PageHeader } from "@/components/ui";

export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Document workspace"
        description="Upload, process, convert, review and export every document in one place."
      />
      <DocumentWorkspaceShell />
    </>
  );
}

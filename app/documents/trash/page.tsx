import { DocumentLibrary } from "@/components/document-library";
import { PageHeader } from "@/components/ui";

export default function TrashDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Trash"
        description="Restore deleted documents or permanently remove files that are no longer needed."
        action={null}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <DocumentLibrary initialFilter="Trash" />
      </div>
    </>
  );
}

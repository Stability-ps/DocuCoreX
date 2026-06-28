import { DocumentLibrary } from "@/components/document-library";
import { PageHeader } from "@/components/ui";

export default function SharedDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Shared documents"
        description="Documents shared with internal teams, auditors, clients and external reviewers."
        action={null}
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <DocumentLibrary initialFilter="Shared" />
      </div>
    </>
  );
}

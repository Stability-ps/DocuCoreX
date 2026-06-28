import { FolderPlus } from "lucide-react";
import { DocumentLibrary } from "@/components/document-library";
import { PageHeader, PrimaryButton } from "@/components/ui";

export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Document Library"
        title="Stored documents, folders and shared workspaces"
        description="Every uploaded file is stored with search, filters, folders, tags, recent files, sharing, starred items, trash and version history."
        action={
          <PrimaryButton href="/upload">
            <FolderPlus className="h-5 w-5" />
            New Upload
          </PrimaryButton>
        }
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <DocumentLibrary />
      </div>
    </>
  );
}

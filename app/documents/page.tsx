import { Upload } from "lucide-react";
import { DocumentLibrary } from "@/components/document-library";
import { PageHeader, PrimaryButton } from "@/components/ui";

export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Document Library"
        title="Stored documents and shared workspaces"
        description="Every uploaded file is stored with search, filters, tags, recent files, sharing, archive and trash."
        action={
          <PrimaryButton href="/upload">
            <Upload className="h-5 w-5" />
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

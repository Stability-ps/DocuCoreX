import { FolderPlus } from "lucide-react";
import { DocumentLibrary } from "@/components/document-library";
import { PageHeader, PrimaryButton } from "@/components/ui";

export default function RecentDocumentsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Recent documents"
        description="Recently uploaded and updated documents across your workspace."
        action={
          <PrimaryButton href="/upload">
            <FolderPlus className="h-5 w-5" />
            New Upload
          </PrimaryButton>
        }
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <DocumentLibrary initialFilter="Recent" />
      </div>
    </>
  );
}

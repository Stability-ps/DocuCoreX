import { FolderPlus } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function DocumentFoldersPage() {
  return (
    <PlaceholderPage
      eyebrow="Documents"
      title="Folders"
      description="Create and manage folder structures for document organisation."
      icon={FolderPlus}
      status="Folder workspace coming soon"
      capabilities={["Folder creation route", "Library organisation", "Workspace-scoped document access"]}
      actions={[{ label: "Back to Library", href: "/documents" }]}
    />
  );
}

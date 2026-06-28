import { FolderPlus } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function DocumentFoldersPage() {
  return (
    <PlaceholderPage
      eyebrow="Documents"
      title="Folders"
      description="Create and manage folder structures for finance, audit, tax, suppliers and client document workspaces."
      icon={FolderPlus}
      status="Folder management shell"
      capabilities={["Create folder destination", "Workspace hierarchy shell", "Ready for folder permissions"]}
      actions={[{ label: "Upload Into Folder", href: "/upload" }]}
    />
  );
}

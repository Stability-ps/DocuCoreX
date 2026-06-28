import { DocumentWorkspace } from "@/components/document-workspace";

export default async function DocumentWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentWorkspace documentId={id} />;
}

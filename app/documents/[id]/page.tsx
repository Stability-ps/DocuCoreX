import { DocumentDetailPanel } from "@/components/documents/document-detail-panel";

export default async function DocumentWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentDetailPanel documentId={id} />;
}

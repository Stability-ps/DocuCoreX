import { UploadCenter } from "@/components/upload-center";
import { PageHeader } from "@/components/ui";

export default async function UploadPage({ searchParams }: { searchParams: Promise<{ workflow?: string }> }) {
  const { workflow } = await searchParams;

  return (
    <>
      <PageHeader
        eyebrow="Upload Center"
        title="Upload, queue and process documents"
        description="A drag-and-drop intake center for PDFs, Office files, images and ZIP archives with multi-file background processing."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <UploadCenter workflow={workflow} />
      </div>
    </>
  );
}

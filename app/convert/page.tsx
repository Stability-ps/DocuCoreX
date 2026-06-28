import { ConversionWorkflow } from "@/components/conversion-workflow";
import { PageHeader } from "@/components/ui";

export default function ConvertPage() {
  return (
    <>
      <PageHeader
        eyebrow="File Conversion"
        title="Convert documents with progress and secure downloads"
        description="Create production workflows for PDF to Word, PDF to Excel, PDF to images, Word to PDF, Excel to PDF and images to PDF."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <ConversionWorkflow />
      </div>
    </>
  );
}


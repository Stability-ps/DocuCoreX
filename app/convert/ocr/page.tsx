import { ScanText } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function OcrPage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="OCR"
      description="Extract searchable text from PDFs, images, scanned documents and camera uploads."
      icon={ScanText}
      status="OCR engine connected"
      capabilities={["Queue OCR jobs", "Review extracted text", "Store OCR output for search"]}
      actions={[
        { label: "Upload for OCR", href: "/upload?workflow=ocr" },
        { label: "Open Documents", href: "/documents" },
      ]}
    />
  );
}

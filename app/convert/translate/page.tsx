import { MessageSquareText } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function TranslatePage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="Translate"
      description="Translate OCR text, summaries and extracted document fields across supported languages."
      icon={MessageSquareText}
      status="Translation shell"
      capabilities={["Language selection area", "Translated text output", "Export-ready translated artifacts"]}
      actions={[{ label: "Upload Document", href: "/upload?workflow=translate" }]}
    />
  );
}

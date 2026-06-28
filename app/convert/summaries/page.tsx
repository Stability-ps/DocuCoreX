import { WandSparkles } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function SummariesPage() {
  return (
    <PlaceholderPage
      eyebrow="Convert Files"
      title="Summaries"
      description="Generate concise financial, legal and operational summaries from uploaded documents."
      icon={WandSparkles}
      status="AI summary shell"
      capabilities={["Document summary workspace", "Risk and anomaly summary area", "Exportable summary artifacts"]}
      actions={[{ label: "Open AI Analysis", href: "/documents" }]}
    />
  );
}

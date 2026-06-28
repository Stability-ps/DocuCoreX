import { BookOpen } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function HelpPage() {
  return (
    <PlaceholderPage
      eyebrow="Help & Support"
      title="Support center"
      description="Find documentation, contact support, send feedback and review implementation guides for DocuCoreX."
      icon={BookOpen}
      status="Support-ready"
      capabilities={["Documentation entry point", "Support request routing", "Implementation and onboarding guides"]}
      actions={[
        { label: "Open Diagnostics", href: "/debug/auth" },
        { label: "Request Automation Support", href: "/settings/automations" },
      ]}
    />
  );
}

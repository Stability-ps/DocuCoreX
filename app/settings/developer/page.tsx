import { Code2 } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function DeveloperSettingsPage() {
  return (
    <PlaceholderPage
      eyebrow="Settings"
      title="Developer"
      description="Manage webhooks, API usage, callbacks and provider configuration for advanced document workflows."
      icon={Code2}
      status="Developer shell"
      capabilities={["API key access", "Webhook configuration route", "Provider configuration workspace"]}
      actions={[{ label: "Open API Keys", href: "/settings/api-keys" }]}
    />
  );
}

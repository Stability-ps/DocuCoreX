import { IntegrationsConsole } from "@/components/integrations-console";
import { PageHeader } from "@/components/ui";

export default function SettingsIntegrationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        description="Connect accounting systems, spreadsheets, cloud storage and webhooks from the settings area."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <IntegrationsConsole />
      </div>
    </>
  );
}

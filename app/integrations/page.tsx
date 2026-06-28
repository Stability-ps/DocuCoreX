import { IntegrationsConsole } from "@/components/integrations-console";
import { PageHeader } from "@/components/ui";

export default function IntegrationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="Connect accounting, storage and export destinations"
        description="Prepare DocuCoreX to pull files from cloud storage and push extracted data into accounting tools, spreadsheets and webhooks."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <IntegrationsConsole />
      </div>
    </>
  );
}

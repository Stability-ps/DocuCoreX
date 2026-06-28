import { AutomationsConsole } from "@/components/automations-console";
import { PageHeader } from "@/components/ui";

export default function SettingsAutomationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Automations"
        description="Create document intake and export pipelines from inside workspace settings."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <AutomationsConsole />
      </div>
    </>
  );
}

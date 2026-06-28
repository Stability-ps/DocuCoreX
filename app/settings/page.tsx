import { SettingsConsole } from "@/components/settings-console";
import { PageHeader } from "@/components/ui";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Workspace controls, security and connected services"
        description="Manage theme, notifications, API keys, security, billing, storage, connected apps and profile settings."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SettingsConsole />
      </div>
    </>
  );
}

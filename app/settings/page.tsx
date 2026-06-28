import { SettingsConsole } from "@/components/settings-console";
import { settingsGroups } from "@/lib/product-data";
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {settingsGroups.map((group) => (
            <article key={group.title} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-soft">
              <group.icon className="h-6 w-6 text-royal-600" />
              <h2 className="mt-4 text-lg font-black text-navy-950">{group.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">{group.detail}</p>
            </article>
          ))}
        </div>

        <SettingsConsole />
      </div>
    </>
  );
}

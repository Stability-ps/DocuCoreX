import { AutomationsConsole } from "@/components/automations-console";
import { PageHeader } from "@/components/ui";

export default function AutomationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Automations"
        title="Build document processing pipelines"
        description="Define where documents arrive, how DocuCoreX processes them, and where structured data should be delivered."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <AutomationsConsole />
      </div>
    </>
  );
}

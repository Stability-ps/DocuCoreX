import { CompanyProfilesManager } from "@/components/settings/company-profiles-manager";
import { PageHeader } from "@/components/ui";

export default function CompanyProfilesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Company Profiles"
        description="Manage the businesses you invoice from. Save banking details and invoice defaults once, then switch companies instantly when creating invoices."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <CompanyProfilesManager />
      </div>
    </>
  );
}

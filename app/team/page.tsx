import { TeamConsole } from "@/components/team-console";
import { PageHeader } from "@/components/ui";

export default function TeamPage() {
  return (
    <>
      <PageHeader
        eyebrow="Team"
        title="Manage users, roles and permissions"
        description="Invite finance, audit and operations users, assign access levels and prepare role-based document permissions."
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <TeamConsole />
      </div>
    </>
  );
}

import { IntakeConsole } from "@/components/intake-console";
import { PageHeader, PrimaryButton } from "@/components/ui";
import { Upload } from "lucide-react";

export default function IntakePage() {
  return (
    <>
      <PageHeader
        eyebrow="Document Intake"
        title="Choose what you are processing"
        description="Route bank statements, invoices, receipts, contracts, payslips, tax forms and other documents into the right extraction workflow."
        action={
          <PrimaryButton href="/upload">
            <Upload className="h-5 w-5" />
            Upload Files
          </PrimaryButton>
        }
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <IntakeConsole />
      </div>
    </>
  );
}

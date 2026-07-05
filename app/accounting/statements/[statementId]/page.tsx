import { StatementWorkspace } from "@/components/accounting/statement-workspace";

// Full-page accountant workspace for reviewing a single statement. Opened from
// the Processing Dashboard (statement name / Open / View). This does NOT replace
// the dashboard — it is a dedicated review route.
export default async function StatementWorkspacePage({
  params,
}: {
  params: Promise<{ statementId: string }>;
}) {
  const { statementId } = await params;
  return <StatementWorkspace statementId={statementId} />;
}

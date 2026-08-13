import { NextResponse } from "next/server";
import { listAccountingEntities, listChartOfAccounts } from "@/lib/accounting/chart-server";

/**
 * The chart of accounts for one entity.
 *
 * Entity-scoped by construction: `companyId` is required rather than defaulted,
 * so a chart is never served for "whichever company came first". Company
 * isolation (§40) is the rule this route exists to keep — an accountant holding
 * several clients in one workspace must never see one client's chart while
 * looking at another.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  return 500;
}

export async function GET(request: Request) {
  const companyId = new URL(request.url).searchParams.get("companyId");

  try {
    const entities = await listAccountingEntities();

    if (!companyId) {
      // No entity chosen: return the entities so the caller can choose one.
      // Deliberately not "pick the default and return its chart" — that reads as
      // a chart for an entity the user did not select.
      return NextResponse.json({ entities, accounts: null });
    }

    return NextResponse.json({ entities, accounts: await listChartOfAccounts(companyId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the chart of accounts.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

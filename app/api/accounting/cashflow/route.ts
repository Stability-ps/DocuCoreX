import { NextResponse } from "next/server";
import { getWorkspaceCashflow } from "@/lib/accounting/server";

/**
 * Cashflow across every statement in the workspace.
 *
 * Workspace-scoped because cash position is not a property of one statement,
 * and not under /fnb/ because cashflow is not bank-specific.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceCashflow());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load cashflow.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

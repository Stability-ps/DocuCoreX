import { NextResponse } from "next/server";
import { decideRecurringPattern, getWorkspaceRecurringPatterns } from "@/lib/accounting/server";

/**
 * Recurring payment patterns and the decisions made about them.
 *
 * Workspace-scoped: a monthly commitment only becomes visible across several
 * statements, so a per-statement view would show almost nothing. Not under
 * /fnb/ — a payment rhythm is not bank-specific.
 */

function statusFor(message: string): number {
  return message === "Unauthorized" ? 401 : 400;
}

export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceRecurringPatterns());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load recurring patterns.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { merchant?: unknown; status?: unknown; observed?: unknown };

  if (typeof body.merchant !== "string" || !body.merchant.trim()) {
    return NextResponse.json({ error: "A merchant is required." }, { status: 400 });
  }
  // Confirmed or dismissed only. A stored "maybe" would eventually be read by
  // forecasting as a yes, which is the failure this endpoint exists to prevent.
  if (body.status !== "confirmed" && body.status !== "dismissed") {
    return NextResponse.json({ error: "Status must be confirmed or dismissed." }, { status: 400 });
  }

  try {
    await decideRecurringPattern(body.merchant, body.status, body.observed);
    return NextResponse.json(await getWorkspaceRecurringPatterns());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record the decision.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

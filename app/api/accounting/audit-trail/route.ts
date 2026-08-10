import { NextResponse } from "next/server";
import { getAccountingAuditTrail } from "@/lib/accounting/server";

/**
 * The accounting audit trail.
 *
 * Read-only by design. Entries are written by the actions they describe, and an
 * audit trail that can be edited through its own endpoint is not one.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const entityId = url.searchParams.get("entityId") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    return NextResponse.json({ entries: await getAccountingAuditTrail({ entityId, limit }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the audit trail.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

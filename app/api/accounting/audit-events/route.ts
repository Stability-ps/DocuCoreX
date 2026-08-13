import { NextResponse } from "next/server";
import { listAuditEvents } from "@/lib/accounting/audit-trail-server";

function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });

  try {
    const result = await listAuditEvents({
      companyId,
      action: url.searchParams.get("action"),
      entityType: url.searchParams.get("entityType"),
      fromDate: url.searchParams.get("from"),
      toDate: url.searchParams.get("to"),
      limit: Number(url.searchParams.get("limit") ?? 50) || 50,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the audit trail.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { listAuditEvents } from "@/lib/accounting/audit-trail-server";

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
    return routeErrorResponse("docucorex.accounting.audit_events.get_failed", error, { message: "Unable to load the audit trail." });
  }
}

import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { listAccountingRuns } from "@/lib/accounting/server";

export async function GET() {
  try {
    return NextResponse.json({ runs: await listAccountingRuns() });
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.fnb_runs.get_failed", error, { message: "Unable to load accounting runs." });
  }
}

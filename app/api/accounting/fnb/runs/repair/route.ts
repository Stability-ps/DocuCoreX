import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { repairStuckAccountingRuns } from "@/lib/accounting/server";

type RepairBody = {
  runId?: string;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as RepairBody;
  try {
    const result = await repairStuckAccountingRuns({ runId: body.runId });
    return NextResponse.json(result);
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.fnb_runs_repair.post_failed", error, { message: "Unable to repair stuck runs." });
  }
}

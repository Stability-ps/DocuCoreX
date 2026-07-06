import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Unable to repair stuck runs.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
  }
}

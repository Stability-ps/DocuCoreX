import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { deleteAccountingRuns } from "@/lib/accounting/server";

type BulkBody = {
  runIds?: string[];
};

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as BulkBody;
  const runIds = Array.from(new Set(body.runIds ?? [])).filter(Boolean);

  if (!runIds.length) {
    return NextResponse.json({ error: "Select at least one statement." }, { status: 400 });
  }

  try {
    const result = await deleteAccountingRuns(runIds);
    return NextResponse.json(result);
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.fnb_runs_bulk.delete_failed", error, { message: "Unable to delete selected statements." });
  }
}

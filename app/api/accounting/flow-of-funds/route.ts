import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { getWorkspaceFlowOfFunds } from "@/lib/accounting/server";

/**
 * Flow of funds, or the reason one cannot yet be drawn honestly.
 *
 * The response is a discriminated union: callers must handle `sufficient:
 * false` and render the reason, rather than an empty chart. A caller cannot
 * accidentally draw a meaningless diagram by ignoring a field.
 */
export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceFlowOfFunds());
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.flow_of_funds.get_failed", error, { message: "Unable to build flow of funds." });
  }
}

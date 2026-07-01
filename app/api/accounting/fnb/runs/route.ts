import { NextResponse } from "next/server";
import { listAccountingRuns } from "@/lib/accounting/server";

export async function GET() {
  try {
    return NextResponse.json({ runs: await listAccountingRuns() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load accounting runs.";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { getWorkspaceCoverage, saveWorkspaceEngagement } from "@/lib/accounting/server";

/**
 * Statement coverage, and the engagement it is measured against.
 *
 * Workspace-scoped: coverage is a statement about the whole engagement, and a
 * per-statement view cannot see what is absent. Not under /fnb/ — whether a
 * month is missing has nothing to do with which bank issued it.
 */

function statusFor(message: string): number {
  return message === "Unauthorized" ? 401 : 400;
}

export async function GET() {
  try {
    return NextResponse.json(await getWorkspaceCoverage());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load statement coverage.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    startDate?: unknown;
    endDate?: unknown;
    expectedAccounts?: unknown;
  };

  const isDateOrNull = (value: unknown) => value === null || value === undefined || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!isDateOrNull(body.startDate) || !isDateOrNull(body.endDate)) {
    return NextResponse.json({ error: "Dates must be YYYY-MM-DD or null." }, { status: 400 });
  }

  try {
    await saveWorkspaceEngagement({
      startDate: (body.startDate as string | null) ?? null,
      endDate: (body.endDate as string | null) ?? null,
      expectedAccounts: Array.isArray(body.expectedAccounts)
        ? body.expectedAccounts.filter((account): account is string => typeof account === "string")
        : [],
    });
    return NextResponse.json(await getWorkspaceCoverage());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save the engagement.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

import { NextResponse } from "next/server";
import { deleteAccountingRuns, getAccountingRunDetail } from "@/lib/accounting/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const detail = await getAccountingRunDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load accounting run.";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const result = await deleteAccountingRuns([id]);
    if (!result.deletedIds.length) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete accounting run.";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : 500 },
    );
  }
}

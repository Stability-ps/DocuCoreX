import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    if (!detail.run.workbookStoragePath) {
      return NextResponse.json({ error: "The Excel workbook is not ready yet." }, { status: 409 });
    }

    const { data, error } = await context.supabase.storage.from("documents").download(detail.run.workbookStoragePath);
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Workbook not found." }, { status: 404 });
    }

    const fileName = `FNB-accounting-workbook-${detail.run.id.slice(0, 8)}.xlsx`;
    return new NextResponse(data, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to export workbook." },
      { status: 500 },
    );
  }
}

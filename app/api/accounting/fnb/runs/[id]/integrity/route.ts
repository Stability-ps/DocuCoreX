import { NextResponse } from "next/server";
import { databaseErrorResponse } from "@/lib/api-errors";
import { errorResponse } from "@/lib/api-auth";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { inspectDocumentIntegrity } from "@/lib/pdf/documentIntegrity";

/**
 * Structural integrity indicators for a statement's source PDF.
 *
 * Runs on the server because it needs the original bytes from storage, and
 * because the browser copy is the one the viewer already re-fetched — inspecting
 * that would report on a round-trip rather than on the file as stored.
 *
 * Returns observations only. There is no score, by design.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const context = await getWorkspaceContext();
    if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const detail = await getAccountingRunDetail(id);
    if (!detail?.run.sourceStoragePath) {
      return NextResponse.json({ error: "Statement source not available." }, { status: 404 });
    }

    const { data, error } = await context.supabase.storage.from("documents").download(detail.run.sourceStoragePath);
    if (error || !data) {
      return databaseErrorResponse("docucorex.accounting.integrity_storage_failed", error, {
        message: "Statement source not available.",
        code: "FILE_UNAVAILABLE",
        status: 404,
        context: { runId: id },
      });
    }

    const bytes = new Uint8Array(await data.arrayBuffer());
    return NextResponse.json(inspectDocumentIntegrity(bytes));
  } catch (error) {
    return errorResponse(error, "Unable to inspect the document.", 500, "docucorex.accounting.integrity_failed");
  }
}

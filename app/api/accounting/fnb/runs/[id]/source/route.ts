import { NextResponse } from "next/server";
import { databaseErrorResponse, routeErrorResponse } from "@/lib/api-errors";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

// Serves the ORIGINAL statement PDF for the Statement Review Workspace viewer.
// Streams the bytes from Supabase Storage same-origin with Content-Disposition:
// inline so the browser RENDERS the PDF in the viewer (a cross-origin signed-URL
// redirect can be blocked from an iframe and render blank in production).
// `?download=1` switches to an attachment response for the Download button.

async function resolvePath(id: string) {
  const context = await getWorkspaceContext();
  if (!context) return { error: "Unauthorized", status: 401 } as const;
  const detail = await getAccountingRunDetail(id);
  if (!detail) return { error: "Statement not found.", status: 404 } as const;
  const path = detail.run.sourceStoragePath;
  if (!path) return { error: "Preview unavailable.", status: 404 } as const;
  return { context, path } as const;
}

export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolvePath(id);
  if ("error" in resolved) return new NextResponse(null, { status: resolved.status });
  return new NextResponse(null, { status: 200, headers: { "content-type": "application/pdf" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const download = new URL(request.url).searchParams.get("download") === "1";

  try {
    const resolved = await resolvePath(id);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const { data, error } = await resolved.context.supabase.storage.from("documents").download(resolved.path);
    if (error || !data) {
      return databaseErrorResponse("docucorex.accounting.source_storage_failed", error, {
        message: "Preview unavailable.",
        code: "FILE_UNAVAILABLE",
        status: 404,
        context: { runId: id },
      });
    }

    const fileName = resolved.path.split("/").pop() || "statement.pdf";
    return new NextResponse(data, {
      headers: {
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${fileName}"`,
        "content-type": data.type || "application/pdf",
        "cache-control": "private, max-age=60",
      },
    });
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.fnb_runs_id_source.get_failed", error, { message: "Unable to load statement source." });
  }
}

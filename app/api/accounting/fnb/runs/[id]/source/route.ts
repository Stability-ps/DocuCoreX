import { NextResponse } from "next/server";
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
      return NextResponse.json({ error: error?.message ?? "Preview unavailable." }, { status: 404 });
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
    const message = error instanceof Error ? error.message : "Unable to load statement source.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
  }
}

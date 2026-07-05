import { NextResponse } from "next/server";
import { getDocument } from "@/lib/mock-repository";
import { isDemoAllowed } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

// Dedicated INLINE preview endpoint for the shared document viewer. Unlike the
// download endpoint (Content-Disposition: attachment) this returns the file with
// Content-Disposition: inline and the correct Content-Type so the browser
// RENDERS it in the viewer instead of downloading it. Preview and download use
// separate logic — this route must never force a download.

function sanitizeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function resolve(id: string) {
  const context = await getWorkspaceContext();
  if (!context) {
    if (!isDemoAllowed) return { error: "Unauthorized", status: 401 } as const;
    const document = getDocument(id);
    if (!document) return { error: "Document not found", status: 404 } as const;
    return { demoName: document.name } as const;
  }

  const { data: row, error } = await context.supabase
    .from("documents")
    .select("id, name, storage_path, mime_type")
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .single();
  if (error || !row) return { error: "Document not found", status: 404 } as const;
  if (!row.storage_path) return { error: "Preview unavailable for this document", status: 409 } as const;
  return { context, row } as const;
}

export async function HEAD(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolve(id);
  if ("error" in resolved) return new NextResponse(null, { status: resolved.status });
  return new NextResponse(null, { status: 200 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const resolved = await resolve(id);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  // Demo mode has no real bytes — return a small inline text placeholder so the
  // viewer renders (never downloads).
  if ("demoName" in resolved) {
    return new NextResponse(`DocuCoreX preview (demo)\nDocument: ${resolved.demoName}\n`, {
      headers: { "content-disposition": "inline", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { context, row } = resolved;
  const { data: fileData, error: fileError } = await context.supabase.storage.from("documents").download(row.storage_path);
  if (fileError || !fileData) {
    return NextResponse.json({ error: fileError?.message ?? "Unable to load document" }, { status: 404 });
  }

  const contentType = row.mime_type || fileData.type || "application/octet-stream";
  return new NextResponse(fileData, {
    headers: {
      "content-disposition": `inline; filename="${sanitizeFileName(row.name)}"`,
      "content-type": contentType,
      "cache-control": "private, max-age=60",
    },
  });
}

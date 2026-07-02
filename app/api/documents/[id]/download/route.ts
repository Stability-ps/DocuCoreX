import { NextResponse } from "next/server";
import { getDocument } from "@/lib/mock-repository";
import { isDemoAllowed } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getWorkspaceContext();

  if (!context) {
    if (!isDemoAllowed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const document = getDocument(id);

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const payload = `DocuCoreX demo download\nDocument: ${document.name}\nPath: ${document.storagePath}\n`;

    return new NextResponse(payload, {
      headers: {
        "content-disposition": `attachment; filename="${sanitizeFileName(document.name)}"`,
        "content-type": "text/plain",
      },
    });
  }

  const { data: documentRow, error: documentError } = await context.supabase
    .from("documents")
    .select("id, name, storage_path")
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .single();

  if (documentError || !documentRow) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  if (!documentRow.storage_path) {
    return NextResponse.json({ error: "Download unavailable for this document" }, { status: 409 });
  }

  const { data: fileData, error: fileError } = await context.supabase.storage.from("documents").download(documentRow.storage_path);

  if (fileError || !fileData) {
    return NextResponse.json({ error: fileError?.message ?? "Unable to download document" }, { status: 404 });
  }

  return new NextResponse(fileData, {
    headers: {
      "content-disposition": `attachment; filename="${sanitizeFileName(documentRow.name)}"`,
      "content-type": fileData.type || "application/octet-stream",
    },
  });
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

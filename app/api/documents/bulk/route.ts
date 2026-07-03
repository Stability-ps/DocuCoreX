import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { bulkDeleteDocuments, patchDocument } from "@/lib/server-documents";

type BulkDocumentBody = {
  documentIds?: string[];
  action?: "delete" | "archive" | "restore" | "share";
};

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as BulkDocumentBody;
  const ids = Array.from(new Set(body.documentIds ?? [])).filter(Boolean);

  if (!ids.length) {
    return NextResponse.json({ error: "Select at least one document." }, { status: 400 });
  }

  const action = body.action ?? "archive";
  const now = new Date().toISOString();

  try {
    const documents = await Promise.all(
      ids.map((id) =>
        patchDocument(
          id,
          action === "archive"
            ? { status: "archived" }
            : action === "restore"
              ? { deletedAt: null, status: "ready" }
              : action === "share"
                ? { shared: true }
                : { deletedAt: now },
        ),
      ),
    );

    return NextResponse.json({ documents: documents.filter(Boolean) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update selected documents." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as BulkDocumentBody;
  const ids = Array.from(new Set(body.documentIds ?? [])).filter(Boolean);

  if (!ids.length) {
    return NextResponse.json({ error: "Select at least one document." }, { status: 400 });
  }

  try {
    const result = await bulkDeleteDocuments(ids);

    await recordAuditLog({
      action: "document_deleted",
      entityType: "document",
      entityId: result.deletedIds[0] ?? "bulk",
      metadata: { count: result.deletedIds.length, bulk: true },
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete selected documents." }, { status: 500 });
  }
}

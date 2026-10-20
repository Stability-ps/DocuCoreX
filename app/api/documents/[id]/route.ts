import { NextResponse } from "next/server";
import { withUnauthorized } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { deleteDocument, getDocumentWithJobs, patchDocument } from "@/lib/server-documents";
import type { DocumentRecord } from "@/lib/types";

async function handleGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getDocumentWithJobs(id);

  if (!result) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  await recordAuditLog({ action: "document_opened", entityType: "document", entityId: id });

  return NextResponse.json(result);
}

async function handlePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Partial<
    Pick<DocumentRecord, "name" | "starred" | "shared" | "tags" | "status" | "deletedAt" | "folderId">
  >;

  const document = await patchDocument(id, body);

  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  if (body.shared !== undefined) {
    await recordAuditLog({
      action: "document_shared",
      entityType: "document",
      entityId: id,
      metadata: { shared: body.shared },
    });
  }

  if (body.deletedAt !== undefined) {
    await recordAuditLog({
      action: "document_deleted",
      entityType: "document",
      entityId: id,
      metadata: { deletedAt: body.deletedAt },
    });
  }

  return NextResponse.json({ document });
}

async function handleDELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = await deleteDocument(id);

  if (!deleted) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  await recordAuditLog({ action: "document_deleted", entityType: "document", entityId: id, metadata: { permanent: true } });

  return NextResponse.json({ deleted: true });
}

// A signed-out request is a 401, not an unhandled 500: the helpers above throw
// "Unauthorized" when there is no session.
export const GET = withUnauthorized(handleGET);
export const PATCH = withUnauthorized(handlePATCH);
export const DELETE = withUnauthorized(handleDELETE);

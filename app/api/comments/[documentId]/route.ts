import { NextResponse } from "next/server";
import { databaseErrorResponse } from "@/lib/api-errors";
import { resolveWorkspaceContext } from "@/lib/api-auth";
import { createDocumentComment, getDocumentComments } from "@/lib/mock-repository";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const context = await resolveWorkspaceContext();
  if (context instanceof Response) return context;

  if (!context) {
    return NextResponse.json({ comments: getDocumentComments(documentId), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("document_comments")
    .select("id, document_id, body, created_at, author_id")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) {
    return databaseErrorResponse("docucorex.comments.list_failed", error, { message: "Unable to load comments.", context: { documentId } });
  }

  return NextResponse.json({
    comments: (data ?? []).map((comment) => ({
      id: comment.id,
      documentId: comment.document_id,
      authorName: comment.author_id ?? "System",
      body: comment.body,
      createdAt: comment.created_at,
    })),
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const body = (await request.json().catch(() => ({}))) as { body?: string; authorName?: string };

  if (!body.body?.trim()) {
    return NextResponse.json({ error: "Comment body is required" }, { status: 400 });
  }

  const context = await resolveWorkspaceContext();
  if (context instanceof Response) return context;

  if (!context) {
    return NextResponse.json({ comment: createDocumentComment(documentId, body.body.trim(), body.authorName), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("document_comments")
    .insert({ document_id: documentId, author_id: context.userId, body: body.body.trim() })
    .select("id, document_id, body, created_at, author_id")
    .single();

  if (error) {
    return databaseErrorResponse("docucorex.comments.create_failed", error, { message: "Unable to save comment.", context: { documentId } });
  }

  return NextResponse.json({
    comment: {
      id: data.id,
      documentId: data.document_id,
      authorName: data.author_id ?? body.authorName ?? "System",
      body: data.body,
      createdAt: data.created_at,
    },
  });
}

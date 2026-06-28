import { NextResponse } from "next/server";
import { createDocumentComment, getDocumentComments } from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ comments: getDocumentComments(documentId), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("document_comments")
    .select("id, document_id, body, created_at, author_id")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ comment: createDocumentComment(documentId, body.body.trim(), body.authorName), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("document_comments")
    .insert({ document_id: documentId, author_id: context.userId, body: body.body.trim() })
    .select("id, document_id, body, created_at, author_id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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

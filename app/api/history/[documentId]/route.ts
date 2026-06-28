import { NextResponse } from "next/server";
import { getDocumentVersionsForWorkspace } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  try {
    return NextResponse.json({ versions: await getDocumentVersionsForWorkspace(documentId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load history" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-auth";
import { getDocumentVersionsForWorkspace } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  try {
    return NextResponse.json({ versions: await getDocumentVersionsForWorkspace(documentId) });
  } catch (error) {
    return errorResponse(error, "Unable to load history");
  }
}

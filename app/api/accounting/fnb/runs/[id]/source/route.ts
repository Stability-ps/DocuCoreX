import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

// Serves the ORIGINAL statement PDF for the Statement Review Workspace viewer.
// Redirects to a short-lived Supabase signed URL so the browser renders the PDF
// directly (no duplicate storage). Returns 404 when the source is unavailable so
// the viewer can show its "Preview unavailable" state.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "Statement not found." }, { status: 404 });
    }

    const path = detail.run.sourceStoragePath;
    if (!path) {
      return NextResponse.json({ error: "Preview unavailable." }, { status: 404 });
    }

    const { data, error } = await context.supabase.storage.from("documents").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: "Preview unavailable." }, { status: 404 });
    }

    return NextResponse.redirect(data.signedUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load statement source.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
  }
}

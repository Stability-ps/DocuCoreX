import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { runExtractionPipeline } from "@/lib/pdf/runExtractionPipeline";

// Runs the multi-parser extraction pipeline (PDF.js → pdfplumber → OCR → score →
// merge → validate) for a stored document and returns the summary for the UI.
// Additive: does not touch upload / convert / download / delete / export flows.
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: row, error } = await context.supabase
      .from("documents")
      .select("id, name, storage_path, mime_type")
      .eq("workspace_id", context.workspaceId)
      .eq("id", documentId)
      .single();
    if (error || !row) {
      return NextResponse.json({ error: "Document not found." }, { status: 404 });
    }
    if (!row.storage_path) {
      return NextResponse.json({ error: "Document has no stored file to analyse." }, { status: 409 });
    }
    if (row.mime_type && !String(row.mime_type).toLowerCase().includes("pdf")) {
      return NextResponse.json({ error: "Extraction analysis is only available for PDF documents." }, { status: 415 });
    }

    const { data: file, error: fileError } = await context.supabase.storage.from("documents").download(row.storage_path);
    if (fileError || !file) {
      return NextResponse.json({ error: fileError?.message ?? "Unable to load document." }, { status: 404 });
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = await runExtractionPipeline(buffer, row.name || "document.pdf");

    // Trim the heavy page/word payload — the UI only needs the summary.
    return NextResponse.json({
      analysis: result.analysis,
      ocrUsed: result.ocrUsed,
      selection: result.selection,
      validation: result.validation,
      warnings: result.warnings,
      requiresReview: result.requiresReview,
      transactionCount: result.merged.transactions.length,
      metadata: result.merged.metadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction analysis failed.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
  }
}

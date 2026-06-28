import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { extractionResults } from "@/lib/mock-repository";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";
import { getDocumentWithJobs, getExtractionForWorkspace, getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const result = await getExtractionForWorkspace(documentId);

  if (!result) {
    return NextResponse.json({
      documentId,
      status: "queued",
      message: "Extraction has not started for this document yet.",
    });
  }

  return NextResponse.json({ extraction: result });
}

export async function POST(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const workspaceDocument = await getDocumentWithJobs(documentId);

  if (!workspaceDocument?.document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const adapters = createWorkflowAdapters();
  const extraction = await adapters.extraction.run(workspaceDocument.document);
  const context = await getWorkspaceContext();

  if (!context) {
    extractionResults.unshift(extraction);
    await recordAuditLog({
      action: "extraction_completed",
      entityType: "document",
      entityId: documentId,
      metadata: { provider: adapters.extraction.name, confidence: extraction.confidence },
    });

    return NextResponse.json({
      extraction,
      job: {
        id: `job_extraction_${Date.now()}`,
        documentId,
        type: "extraction",
        status: "completed",
        progress: 100,
        message: "Extraction completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      mode: "demo",
    });
  }

  const { data: extractionData, error: extractionError } = await context.supabase
    .from("extraction_results")
    .insert({
      document_id: documentId,
      detected_type: extraction.detectedType,
      confidence: extraction.confidence,
      fields: extraction.fields,
      line_items: extraction.lineItems,
    })
    .select("id, document_id, detected_type, confidence, fields, line_items, created_at")
    .single();

  if (extractionError || !extractionData) {
    return NextResponse.json({ error: extractionError?.message ?? "Unable to save extraction result" }, { status: 500 });
  }

  const { data: jobData, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert({
      document_id: documentId,
      type: "extraction",
      status: "completed",
      progress: 100,
      message: "Extraction completed",
    })
    .select("id, document_id, type, status, progress, message, created_at, updated_at")
    .single();

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  await recordAuditLog({
    action: "extraction_completed",
    entityType: "document",
    entityId: documentId,
    metadata: { provider: adapters.extraction.name, confidence: Number(extractionData.confidence) },
  });

  return NextResponse.json({
    extraction: {
      id: extractionData.id,
      documentId: extractionData.document_id,
      detectedType: extractionData.detected_type,
      confidence: Number(extractionData.confidence),
      fields: extractionData.fields ?? {},
      lineItems: extractionData.line_items ?? [],
      createdAt: extractionData.created_at,
    },
    job: jobData
      ? {
          id: jobData.id,
          documentId: jobData.document_id,
          type: jobData.type,
          status: jobData.status,
          progress: jobData.progress,
          message: jobData.message,
          createdAt: jobData.created_at,
          updatedAt: jobData.updated_at,
        }
      : null,
  });
}

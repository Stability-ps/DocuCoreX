import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { ocrResults } from "@/lib/mock-repository";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";
import { getDocumentWithJobs, getOcrForWorkspace, getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const result = await getOcrForWorkspace(documentId);

  if (!result) {
    return NextResponse.json({
      documentId,
      status: "queued",
      message: "OCR has not started for this document yet.",
    });
  }

  return NextResponse.json({ ocr: result });
}

export async function POST(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const workspaceDocument = await getDocumentWithJobs(documentId);

  if (!workspaceDocument?.document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const adapters = createWorkflowAdapters();
  const ocr = await adapters.ocr.run(workspaceDocument.document);
  const context = await getWorkspaceContext();

  if (!context) {
    ocrResults.unshift(ocr);
    await recordAuditLog({
      action: "extraction_completed",
      entityType: "document",
      entityId: documentId,
      metadata: { stage: "ocr", provider: adapters.ocr.name, confidence: ocr.confidence },
    });

    return NextResponse.json({
      ocr,
      job: {
        id: `job_ocr_${Date.now()}`,
        documentId,
        type: "ocr",
        status: "completed",
        progress: 100,
        message: "OCR completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      mode: "demo",
    });
  }

  const { data: ocrData, error: ocrError } = await context.supabase
    .from("ocr_results")
    .insert({
      document_id: documentId,
      language: ocr.language,
      confidence: ocr.confidence,
      text: ocr.text,
      layout: { status: ocr.layoutStatus },
    })
    .select("id, document_id, language, confidence, text, created_at")
    .single();

  if (ocrError || !ocrData) {
    return NextResponse.json({ error: ocrError?.message ?? "Unable to save OCR result" }, { status: 500 });
  }

  const { data: jobData, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert({
      document_id: documentId,
      type: "ocr",
      status: "completed",
      progress: 100,
      message: "OCR completed",
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
    metadata: { stage: "ocr", provider: adapters.ocr.name, confidence: Number(ocrData.confidence) },
  });

  return NextResponse.json({
    ocr: {
      id: ocrData.id,
      documentId: ocrData.document_id,
      language: ocrData.language,
      confidence: Number(ocrData.confidence),
      text: ocrData.text,
      layoutStatus: "complete",
      createdAt: ocrData.created_at,
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

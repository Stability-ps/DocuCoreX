// Background OCR/extraction job lifecycle. Reuses the existing `processing_jobs`
// table and the ocr_results / extraction_results result tables so the API can
// return 202 immediately and process heavy OCR after the response (via Next's
// `after()`), instead of holding the browser request open for ~43s.
import type { WorkspaceContext } from "@/lib/server-documents";
import type { DocumentRecord } from "@/lib/types";
import { recordAuditLog } from "@/lib/audit";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";

export type ProcessingType = "ocr" | "extraction";

export { resolveJobAction, type JobAction } from "@/lib/ocr/jobAction";

type JobRow = { id: string; status: string };

// Find an in-flight (queued/running) job of this type for the document.
export async function findActiveJob(context: WorkspaceContext, documentId: string, type: ProcessingType): Promise<JobRow | null> {
  const { data } = await context.supabase
    .from("processing_jobs")
    .select("id, status")
    .eq("document_id", documentId)
    .eq("type", type)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

export async function createRunningJob(context: WorkspaceContext, documentId: string, type: ProcessingType): Promise<JobRow> {
  const { data, error } = await context.supabase
    .from("processing_jobs")
    .insert({ document_id: documentId, type, status: "running", progress: 10, message: `${type === "ocr" ? "OCR" : "Extraction"} processing` })
    .select("id, status")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Unable to create processing job");
  // Reflect processing on the document so the UI shows a live status and keeps polling.
  await context.supabase.from("documents").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", documentId);
  return data as JobRow;
}

async function completeJob(context: WorkspaceContext, jobId: string, message: string) {
  await context.supabase
    .from("processing_jobs")
    .update({ status: "completed", progress: 100, message, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function failJob(context: WorkspaceContext, jobId: string, documentId: string, message: string) {
  await context.supabase
    .from("processing_jobs")
    .update({ status: "failed", progress: 100, message, error: message, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  // Surface a clear failure on the document rather than leaving it queued.
  await context.supabase.from("documents").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", documentId);
}

// Background OCR: runs the provider (may take ~43s), stores the result, and marks
// the job completed/failed. Called from `after()` so the browser is not blocked.
export async function runOcrJob(context: WorkspaceContext, document: DocumentRecord, jobId: string): Promise<void> {
  try {
    const adapters = createWorkflowAdapters();
    const ocr = await adapters.ocr.run(document);
    await context.supabase.from("ocr_results").insert({
      document_id: document.id,
      language: ocr.language,
      confidence: ocr.confidence,
      text: ocr.text,
      layout: { status: ocr.layoutStatus, provider: adapters.ocr.name },
    });
    await completeJob(context, jobId, "OCR completed");
    await recordAuditLog({ action: "extraction_completed", entityType: "document", entityId: document.id, metadata: { stage: "ocr", provider: adapters.ocr.name, confidence: ocr.confidence } });
  } catch (error) {
    await failJob(context, jobId, document.id, error instanceof Error ? error.message : "OCR failed");
  }
}

export async function runExtractionJob(context: WorkspaceContext, document: DocumentRecord, jobId: string): Promise<void> {
  try {
    const adapters = createWorkflowAdapters();
    const extraction = await adapters.extraction.run(document);
    await context.supabase.from("extraction_results").insert({
      document_id: document.id,
      detected_type: extraction.detectedType,
      confidence: extraction.confidence,
      fields: extraction.fields,
      line_items: extraction.lineItems,
    });
    await context.supabase.from("documents").update({ status: "ready", detected_type: extraction.detectedType, updated_at: new Date().toISOString() }).eq("id", document.id);
    await completeJob(context, jobId, "Extraction completed");
    await recordAuditLog({ action: "extraction_completed", entityType: "document", entityId: document.id, metadata: { provider: extraction.fields?.provider ?? "unknown", confidence: extraction.confidence } });
  } catch (error) {
    await failJob(context, jobId, document.id, error instanceof Error ? error.message : "Extraction failed");
  }
}

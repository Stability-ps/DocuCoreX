// Background OCR/extraction job lifecycle. Reuses the existing `processing_jobs`
// table and the ocr_results / extraction_results result tables so the API can
// return 202 immediately and process heavy OCR after the response (via Next's
// `after()`), instead of holding the browser request open for ~43s.
import type { WorkspaceContext } from "@/lib/server-documents";
import type { DocumentRecord } from "@/lib/types";
import { recordAuditLog } from "@/lib/audit";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";

export type ProcessingType = "ocr" | "extraction";

export { resolveJobAction, type JobAction, isStaleJob, STALE_JOB_MS } from "@/lib/ocr/jobAction";
import { isStaleJob } from "@/lib/ocr/jobAction";

type JobRow = { id: string; status: string };
const UNIQUE_VIOLATION = "23505";

// Reclaim jobs whose serverless worker died (stuck queued/running past STALE_JOB_MS)
// so a fresh job can run and the unique-active-job index does not block it forever.
export async function reclaimStaleJobs(context: WorkspaceContext, documentId: string, type: ProcessingType): Promise<void> {
  const nowMs = Date.now();
  const { data } = await context.supabase
    .from("processing_jobs")
    .select("id, status, updated_at")
    .eq("document_id", documentId)
    .eq("type", type)
    .in("status", ["queued", "running"]);
  const stale = (data ?? []).filter((j) => isStaleJob({ status: j.status, updatedAt: j.updated_at, nowMs }));
  for (const job of stale) {
    await context.supabase
      .from("processing_jobs")
      .update({ status: "failed", error: "Processing stalled (worker did not finish in time).", message: "Stalled — reclaimed", updated_at: new Date().toISOString() })
      .eq("id", job.id);
  }
}

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

// Cancel any active job for a document+type — used by an explicit reprocess so the
// new job does not violate the one-active-job-per-doc/type unique index.
export async function cancelActiveJobs(context: WorkspaceContext, documentId: string, type: ProcessingType): Promise<void> {
  await context.supabase
    .from("processing_jobs")
    .update({ status: "cancelled", message: "Superseded by reprocess", updated_at: new Date().toISOString() })
    .eq("document_id", documentId)
    .eq("type", type)
    .in("status", ["queued", "running"]);
}

export async function createRunningJob(context: WorkspaceContext, documentId: string, type: ProcessingType): Promise<JobRow> {
  const { data, error } = await context.supabase
    .from("processing_jobs")
    .insert({ document_id: documentId, type, status: "running", progress: 10, message: `${type === "ocr" ? "OCR" : "Extraction"} processing` })
    .select("id, status")
    .single();

  if (error) {
    // Concurrent-insert safety: another request won the race and created the active
    // job (unique-index violation). Attach to it instead of erroring/duplicating.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const existing = await findActiveJob(context, documentId, type);
      if (existing) return existing;
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Unable to create processing job");
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
  await finalizeDocumentStatus(context, documentId);
}

// Set the document status from the current job/result state after a job finishes:
//  - any active job still running  → stays "processing"
//  - an extraction result exists   → "ready"
//  - otherwise a failed job        → "failed"
//  - otherwise (e.g. OCR-only done) → "ready"
// This ensures an OCR-only run moves the document OUT of "processing".
export async function finalizeDocumentStatus(context: WorkspaceContext, documentId: string): Promise<void> {
  const { data: jobs } = await context.supabase
    .from("processing_jobs")
    .select("status, type")
    .eq("document_id", documentId)
    .in("type", ["ocr", "extraction"])
    .order("created_at", { ascending: false })
    .limit(10);
  const rows = jobs ?? [];
  if (rows.some((j) => j.status === "queued" || j.status === "running")) return; // still working

  const { data: extraction } = await context.supabase
    .from("extraction_results")
    .select("id")
    .eq("document_id", documentId)
    .limit(1)
    .maybeSingle();

  const anyFailed = rows.some((j) => j.status === "failed");
  const status = extraction ? "ready" : anyFailed ? "failed" : "ready";
  await context.supabase.from("documents").update({ status, updated_at: new Date().toISOString() }).eq("id", documentId);
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
    // Move the document out of "processing" even for an OCR-only run (no pending
    // extraction) — finalize inspects remaining jobs/results.
    await finalizeDocumentStatus(context, document.id);
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
    await context.supabase.from("documents").update({ detected_type: extraction.detectedType, updated_at: new Date().toISOString() }).eq("id", document.id);
    await completeJob(context, jobId, "Extraction completed");
    await finalizeDocumentStatus(context, document.id);
    await recordAuditLog({ action: "extraction_completed", entityType: "document", entityId: document.id, metadata: { provider: extraction.fields?.provider ?? "unknown", confidence: extraction.confidence } });
  } catch (error) {
    await failJob(context, jobId, document.id, error instanceof Error ? error.message : "Extraction failed");
  }
}

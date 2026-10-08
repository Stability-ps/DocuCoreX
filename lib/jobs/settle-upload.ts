import type { WorkspaceContext } from "@/lib/server-documents";
import { uploadSettledMessage, type UploadSettlement } from "@/lib/jobs/upload-job";

/**
 * Close a document's open upload job because another route has just started
 * its processing. The upload itself is proven by the document row the caller
 * already loaded (registerUploads only inserts it once the object is stored),
 * and the job's remaining work — starting the pipeline — is what the caller is
 * doing. Only queued jobs are settled: a running one belongs to an in-flight
 * /api/jobs/process call, which completes it itself.
 *
 * A conversion does not process the document itself (no OCR, no extraction),
 * so a document that registration left "queued" goes back to "uploaded": the
 * state in which the UI offers "Process". Otherwise a failed conversion would
 * leave it "queued" with nothing left to run it.
 */
export async function settleUploadJobs(
  context: Pick<WorkspaceContext, "supabase">,
  documentIds: string[],
  startedBy: UploadSettlement,
): Promise<void> {
  if (!documentIds.length) return;
  const { error } = await context.supabase
    .from("processing_jobs")
    .update({ status: "completed", progress: 100, message: uploadSettledMessage(startedBy), updated_at: new Date().toISOString() })
    .in("document_id", documentIds)
    .eq("type", "upload")
    .eq("status", "queued");
  if (error) {
    // Not fatal for the caller's own work, but never silent.
    console.error("docucorex.upload_job.settle_failed", { documentIds, startedBy, message: error.message });
    return;
  }
  if (startedBy === "conversion") {
    await context.supabase
      .from("documents")
      .update({ status: "uploaded", updated_at: new Date().toISOString() })
      .in("id", documentIds)
      .eq("status", "queued");
  }
}

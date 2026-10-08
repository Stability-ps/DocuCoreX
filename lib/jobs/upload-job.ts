// Lifecycle of the "upload" processing job (pure rules; unit-tested).
//
// An upload job is created when a document is registered. Its work is to start
// the document's pipeline: POST /api/jobs/process claims it, queues OCR and
// extraction, and completes it. Other routes start work for a document directly
// (extraction, OCR, conversions); before 2026-10-08 none of them closed the
// upload job, so it sat "queued" forever beside a finished document, and any
// later /api/jobs/process call for that document would fan out a second OCR and
// extraction run. Those routes now settle it (lib/jobs/settle-upload.ts) instead.
export type PipelineJobType = "ocr" | "extraction";

export type PipelineState = {
  hasOcrResult: boolean;
  hasActiveOcrJob: boolean;
  hasExtractionResult: boolean;
  hasActiveExtractionJob: boolean;
};

/**
 * Which pipeline jobs an upload job should queue. A stage that already has a
 * result or an in-flight job is skipped: queueing it again would either redo
 * paid work or violate the one-active-job-per-document/type index (016).
 */
export function pipelineJobsToQueue(state: PipelineState): PipelineJobType[] {
  const queue: PipelineJobType[] = [];
  if (!state.hasOcrResult && !state.hasActiveOcrJob) queue.push("ocr");
  if (!state.hasExtractionResult && !state.hasActiveExtractionJob) queue.push("extraction");
  return queue;
}

export type UploadSettlement = "extraction" | "ocr" | "conversion";

export function uploadSettledMessage(startedBy: UploadSettlement): string {
  return `Upload registered; ${startedBy === "ocr" ? "OCR" : startedBy} started directly`;
}

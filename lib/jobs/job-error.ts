// The failure text a processing job stores in processing_jobs.message/.error.
//
// Those columns are read back by /api/jobs, /api/documents/[id] and the
// conversion poller, and shown on the document and in the conversion toast. A
// raw `error.message` put PostgREST and Storage text (object paths, table
// names), provider responses and OCR engine output there for anyone in the
// workspace to read. A deliberate message — a UserFacingError, or a
// ConversionError, whose messages are written for people — is kept; anything
// else becomes a per-job-type sentence, and the detail goes to the server log.

import { ConversionError } from "@/lib/document-conversion-engine";
import { isUserFacingError } from "@/lib/user-facing-error";

const JOB_FAILURE_MESSAGES: Record<string, string> = {
  upload: "Upload processing failed. Please try again.",
  ocr: "Text recognition failed. Please try again.",
  extraction: "Data extraction failed. Please try again.",
  conversion: "Conversion failed. Please try again.",
};

export function genericJobFailureMessage(jobType: string) {
  return JOB_FAILURE_MESSAGES[jobType] ?? "Processing failed. Please try again.";
}

/** A user-safe failure message for `jobType`; logs the detail when it is replaced. */
export function userSafeJobError(error: unknown, jobType: string, context: Record<string, unknown> = {}): string {
  if (isUserFacingError(error) || error instanceof ConversionError) return error.message;
  console.error("docucorex.job.failed", {
    ...context,
    jobType,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return genericJobFailureMessage(jobType);
}

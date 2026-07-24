export type ProcessingMode = "process" | "demo" | "unresolved";

/**
 * Decides how `POST /api/jobs/process` should proceed once workspace-context
 * resolution has already been attempted.
 *
 * Pure and fully unit-tested so the core invariant cannot silently regress:
 * a real, Supabase-backed deployment must NEVER fall back to the in-memory
 * "demo" path (which returns `processed: 0, mode: "demo"` and leaves real
 * uploads permanently queued). The demo path only exists when there is
 * genuinely no Supabase backend configured at all.
 */
export function resolveProcessingMode(input: {
  hasContext: boolean;
  isSupabaseConfigured: boolean;
}): ProcessingMode {
  // A resolved workspace context always processes real jobs.
  if (input.hasContext) return "process";

  // No context + no backend → the genuine local/demo experience.
  if (!input.isSupabaseConfigured) return "demo";

  // No context but a real backend IS configured → an authenticated production
  // job whose workspace could not be resolved. Surface an error; never demo.
  return "unresolved";
}

export type ProcessableJobType = "upload" | "ocr" | "extraction" | "conversion";

/**
 * The document status once a job of the given type completes successfully.
 * Centralised so the happy-path progression (upload → queued → processing →
 * ready) is defined in one tested place rather than as scattered literals.
 */
export function documentStatusAfterJob(type: ProcessableJobType): "queued" | "processing" | "ready" {
  switch (type) {
    case "upload":
      return "queued";
    case "ocr":
      return "processing";
    case "extraction":
    case "conversion":
    default:
      return "ready";
  }
}

/**
 * The document status when a job fails. A conversion failure leaves the source
 * document intact (the original is still valid; the conversion record carries
 * the error), so it returns null. Every other job type marks the document
 * `failed` so the UI shows a clear error instead of a permanent queued state.
 */
export function documentStatusOnJobFailure(type: ProcessableJobType): "failed" | null {
  return type === "conversion" ? null : "failed";
}

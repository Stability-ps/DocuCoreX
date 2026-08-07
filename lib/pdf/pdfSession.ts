/**
 * Teardown for a pdf.js document session.
 *
 * Which object owns teardown is not obvious, and getting it wrong is silent
 * until something unmounts. In pdfjs-dist 6.x:
 *
 *   PDFDocumentLoadingTask  — has destroy(). Tears down the document AND the
 *                             worker. This is the owner.
 *   PDFDocumentProxy        — has cleanup(), which frees per-page resources
 *                             only. It has NO destroy().
 *
 * The viewer held the proxy returned by `getDocument(...).promise` and called
 * `destroy()` on it. That is `undefined`, so every unmount threw
 * "l.destroy is not a function" into the error boundary — after the PDF had
 * already rendered, because the reference is only set once the load succeeds.
 *
 * Framework-free on purpose: this is the piece worth testing directly, and a
 * test that has to mount React to check a teardown call would be testing the
 * wrong thing.
 */

/** The part of pdf.js's loading task this module needs. */
export type PdfLoadingTaskLike = { destroy: () => Promise<void> };

/**
 * Destroy a pdf.js session, safely and idempotently.
 *
 * Idempotent because cleanup legitimately runs more than once: React invokes
 * effect cleanup on unmount and again on every dependency change, and in
 * StrictMode twice on mount. Returns whether there was anything to destroy, so
 * a caller can assert the teardown actually happened rather than assume it.
 *
 * Rejections are swallowed deliberately and only here: `destroy()` rejects when
 * the worker has already gone — a teardown that is already complete, not a
 * failure. Nothing else about the call is guarded, so a genuinely wrong object
 * still throws loudly rather than being hidden.
 */
export function destroyPdfSession(task: PdfLoadingTaskLike | null | undefined): boolean {
  if (!task) return false;
  if (typeof task.destroy !== "function") {
    // Not a loading task. Say so rather than continuing quietly — this is the
    // exact mistake the module exists to prevent, and swallowing it would hide
    // the next pdf.js API change the same way this one was hidden.
    throw new TypeError("destroyPdfSession expects a pdf.js loading task with destroy(); received an object without one");
  }
  void Promise.resolve(task.destroy()).catch(() => undefined);
  return true;
}

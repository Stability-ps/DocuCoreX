// pdf.js ships the worker as a bare .mjs without types. We import it only to
// register globalThis.pdfjsWorker for server-side (main-thread) text extraction.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";

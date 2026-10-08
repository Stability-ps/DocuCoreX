import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pipelineJobsToQueue, uploadSettledMessage } from "../../lib/jobs/upload-job.ts";
import { isClaimable, STALE_JOB_MS } from "../../lib/ocr/jobAction.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");
const none = { hasOcrResult: false, hasActiveOcrJob: false, hasExtractionResult: false, hasActiveExtractionJob: false };

// ── Upload fan-out: only the stages that have not run ────────────────────────

test("a fresh upload queues OCR and extraction", () => {
  assert.deepEqual(pipelineJobsToQueue(none), ["ocr", "extraction"]);
});

test("an upload whose document was already extracted queues no second extraction", () => {
  // Production, 2026-10-08: the extraction route had finished the document while
  // its upload job sat queued; claiming that job used to queue OCR + extraction again.
  assert.deepEqual(pipelineJobsToQueue({ ...none, hasExtractionResult: true }), ["ocr"]);
  assert.deepEqual(pipelineJobsToQueue({ ...none, hasOcrResult: true, hasExtractionResult: true }), []);
});

test("an in-flight stage is never queued twice (one-active-job index, 016)", () => {
  assert.deepEqual(pipelineJobsToQueue({ ...none, hasActiveOcrJob: true, hasActiveExtractionJob: true }), []);
  assert.deepEqual(pipelineJobsToQueue({ ...none, hasActiveExtractionJob: true }), ["ocr"]);
});

// ── Claim rule ───────────────────────────────────────────────────────────────

test("queued jobs are claimable; a fresh running job is not", () => {
  const now = Date.parse("2026-10-08T07:00:00Z");
  assert.equal(isClaimable({ status: "queued", updatedAt: "2026-10-08T06:59:59Z" }, now), true);
  // The 2.5 s poller used to re-run running jobs: 5 OCR results in 0.3 s.
  assert.equal(isClaimable({ status: "running", updatedAt: "2026-10-08T06:59:59Z" }, now), false);
});

test("a running job whose worker died becomes claimable once stale", () => {
  const now = Date.parse("2026-10-08T07:00:00Z");
  const stale = new Date(now - STALE_JOB_MS - 1000).toISOString();
  assert.equal(isClaimable({ status: "running", updatedAt: stale }, now), true);
});

test("terminal jobs are never claimable", () => {
  const now = Date.now();
  for (const status of ["completed", "failed", "cancelled", "output_ready"]) {
    assert.equal(isClaimable({ status, updatedAt: new Date(0).toISOString() }, now), false, status);
  }
});

// ── Wiring (source checks: these paths need Supabase to run) ─────────────────

test("jobs/process claims with a conditional update before doing any work", () => {
  const route = read("app/api/jobs/process/route.ts");
  const claim = route.indexOf('.eq("updated_at", job.updated_at)');
  assert.ok(claim > 0, "claim must be conditional on the row being unchanged");
  assert.ok(route.includes('.eq("status", job.status)'));
  assert.ok(route.includes("isClaimable("));
  assert.ok(claim < route.indexOf('if (job.type === "upload")'), "claim precedes the upload branch");
  assert.ok(claim < route.indexOf("providers.ocr.run(document)"), "claim precedes OCR");
});

test("jobs/process fans an upload out only to the stages still missing", () => {
  const route = read("app/api/jobs/process/route.ts");
  assert.ok(route.includes("pipelineJobsToQueue(await readPipelineState("));
  assert.ok(!route.includes('{ document_id: document.id, type: "ocr", status: "queued", progress: 0, message: "OCR queued" },'), "the unconditional OCR+extraction insert is gone");
});

test("every route that starts work directly settles the upload job", () => {
  assert.match(read("lib/ocr/asyncJobs.ts"), /settleUploadJobs\(context, \[documentId\], type\)/);
  assert.match(read("app/api/conversions/route.ts"), /settleUploadJobs\(context, \[body\.documentId\], "conversion"\)/);
  assert.match(read("app/api/uploads/workflow/route.ts"), /settleUploadJobs\(context, documents\.map\(\(document\) => document\.id\), "conversion"\)/);
  const settle = read("lib/jobs/settle-upload.ts");
  assert.ok(settle.includes('.eq("status", "queued")'), "only queued upload jobs are settled, never a running claim");
});

test("registration leaves the document queued so the poller recovers a lost process call", () => {
  const registration = read("lib/server-documents.ts");
  const insert = registration.slice(registration.indexOf("const documentsToInsert"), registration.indexOf("const { data: insertedDocuments"));
  assert.ok(insert.includes('status: "queued" as const'));
  const shell = read("components/documents/document-workspace-shell.tsx");
  assert.ok(shell.includes('["queued", "processing"].includes(document.status)'), "the poller drives queued documents");
});

test("settled upload jobs say why they closed", () => {
  assert.equal(uploadSettledMessage("extraction"), "Upload registered; extraction started directly");
  assert.equal(uploadSettledMessage("ocr"), "Upload registered; OCR started directly");
});

// ── Authorisation of /api/jobs/process (release audit, 2026-10-08) ──────────

test("process request ids must be UUIDs (no ILIKE wildcards)", async () => {
  const { validateProcessRequest } = await import("../../lib/jobs/process-request.ts");
  assert.equal(validateProcessRequest({ conversionId: "%" }).ok, false);
  assert.equal(validateProcessRequest({ documentId: "1 or 1=1" }).ok, false);
  assert.equal(validateProcessRequest({ jobId: 42 }).ok, false);
  const ok = validateProcessRequest({ documentId: "cf4f8033-c872-48d2-bf30-31da4a154fab", other: "ignored" });
  assert.deepEqual(ok, { ok: true, request: { documentId: "cf4f8033-c872-48d2-bf30-31da4a154fab" } });
  assert.deepEqual(validateProcessRequest(null), { ok: true, request: {} });
});

test("the frontend authorises the caller and the target before proxying to the worker", () => {
  const route = read("app/api/jobs/process/route.ts");
  const auth = route.indexOf('code: "UNAUTHENTICATED"');
  const ownership = route.indexOf("requestTargetsWorkspace(caller, processRequest)");
  const proxy = route.indexOf("await proxyToConversionWorker(request, processRequest)");
  assert.ok(auth > 0 && ownership > 0 && proxy > 0);
  assert.ok(auth < proxy && ownership < proxy, "no request reaches the worker unauthorised");
});

test("the worker fails closed when its shared secret is not configured", () => {
  const route = read("app/api/jobs/process/route.ts");
  assert.ok(route.includes("WORKER_SECRET_NOT_CONFIGURED"));
  assert.ok(!route.includes("if (configuredSecret && providedSecret !== configuredSecret)"), "a missing secret no longer disables the check");
});

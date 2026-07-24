import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isStaleJob, STALE_JOB_MS } from "../../lib/ocr/jobAction.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const NOW = 1_700_000_000_000;

// ── Stale-job detection (pure) ───────────────────────────────────────────────

test("a running job past the stale window is reclaimable", () => {
  assert.equal(isStaleJob({ status: "running", updatedAt: new Date(NOW - STALE_JOB_MS - 1000).toISOString(), nowMs: NOW }), true);
  assert.equal(isStaleJob({ status: "queued", updatedAt: new Date(NOW - STALE_JOB_MS - 1000).toISOString(), nowMs: NOW }), true);
});

test("a fresh or terminal job is not stale", () => {
  assert.equal(isStaleJob({ status: "running", updatedAt: new Date(NOW - 5000).toISOString(), nowMs: NOW }), false);
  assert.equal(isStaleJob({ status: "completed", updatedAt: new Date(NOW - STALE_JOB_MS - 1000).toISOString(), nowMs: NOW }), false);
  assert.equal(isStaleJob({ status: "failed", updatedAt: new Date(0).toISOString(), nowMs: NOW }), false);
  assert.equal(isStaleJob({ status: "running", updatedAt: null, nowMs: NOW }), false); // unknown timestamp is never treated as stale
});

// ── Migration + idempotency wiring (static guards) ───────────────────────────

test("migration 016 enforces one active job per document + type", () => {
  const sql = read("supabase/migrations/016_processing_job_idempotency.sql");
  assert.match(sql, /create unique index if not exists processing_jobs_one_active_per_doc_type/);
  assert.match(sql, /on public\.processing_jobs \(document_id, type\)/);
  assert.match(sql, /where status in \('queued', 'running'\)/);
});

test("createRunningJob attaches on a concurrent unique-violation instead of duplicating", () => {
  const src = read("lib/ocr/asyncJobs.ts");
  assert.match(src, /UNIQUE_VIOLATION = "23505"/);
  assert.match(src, /=== UNIQUE_VIOLATION[\s\S]{0,120}findActiveJob/);
});

test("reprocess cancels active jobs; stalled jobs are reclaimed; OCR-only finalizes the doc", () => {
  const jobs = read("lib/ocr/asyncJobs.ts");
  assert.match(jobs, /export async function cancelActiveJobs/);
  assert.match(jobs, /export async function reclaimStaleJobs/);
  assert.match(jobs, /export async function finalizeDocumentStatus/);
  for (const route of ["app/api/ocr/[documentId]/route.ts", "app/api/extractions/[documentId]/route.ts"]) {
    const src = read(route);
    assert.match(src, /reclaimStaleJobs\(context/, `${route} reclaims stale jobs`);
    assert.match(src, /if \(force\) await cancelActiveJobs\(context/, `${route} cancels active jobs on reprocess`);
  }
  // OCR completion finalizes the document status (moves out of "processing").
  assert.match(jobs, /await completeJob\(context, jobId, "OCR completed"\)/);
  assert.match(jobs, /runOcrJob[\s\S]*?await finalizeDocumentStatus\(context, document\.id\)/);
});

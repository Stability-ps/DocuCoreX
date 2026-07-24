import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveProcessingMode,
  documentStatusAfterJob,
  documentStatusOnJobFailure,
} from "../../lib/jobs/processing-mode.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");

// ── Functional: no silent demo fallback for authenticated production jobs ─────

test("resolveProcessingMode processes real jobs whenever a workspace context exists", () => {
  assert.equal(resolveProcessingMode({ hasContext: true, isSupabaseConfigured: true }), "process");
  assert.equal(resolveProcessingMode({ hasContext: true, isSupabaseConfigured: false }), "process");
});

test("resolveProcessingMode only allows demo when there is genuinely no Supabase backend", () => {
  assert.equal(resolveProcessingMode({ hasContext: false, isSupabaseConfigured: false }), "demo");
});

test("resolveProcessingMode NEVER returns demo for a real backend without context (the core invariant)", () => {
  // A Supabase-backed deployment that cannot resolve a workspace must surface an
  // error — not silently return processed:0/mode:"demo" and strand the upload.
  assert.equal(resolveProcessingMode({ hasContext: false, isSupabaseConfigured: true }), "unresolved");
});

// ── Functional: successful status progression (upload → queued → processing → ready) ─

test("documentStatusAfterJob encodes the happy-path progression", () => {
  assert.equal(documentStatusAfterJob("upload"), "queued");
  assert.equal(documentStatusAfterJob("ocr"), "processing");
  assert.equal(documentStatusAfterJob("extraction"), "ready");
  assert.equal(documentStatusAfterJob("conversion"), "ready");
});

// ── Functional: worker/job failure status ────────────────────────────────────

test("documentStatusOnJobFailure marks non-conversion jobs failed and leaves the source intact for conversions", () => {
  assert.equal(documentStatusOnJobFailure("upload"), "failed");
  assert.equal(documentStatusOnJobFailure("ocr"), "failed");
  assert.equal(documentStatusOnJobFailure("extraction"), "failed");
  assert.equal(documentStatusOnJobFailure("conversion"), null);
});

// ── Static wiring guards: the route + clients must use the above correctly ────

test("upload panel triggers /api/jobs/process for a specific documentId (never a context-less call)", () => {
  const source = read("components/documents/document-upload-panel.tsx");
  assert.match(
    source,
    /fetch\("\/api\/jobs\/process",\s*\{[\s\S]*?body:\s*JSON\.stringify\(\{\s*documentId\s*\}\)/,
    "upload must POST /api/jobs/process with a { documentId } body",
  );
  // The old fire-and-forget, context-less trigger must be gone.
  assert.doesNotMatch(
    source,
    /fetch\("\/api\/jobs\/process",\s*\{\s*method:\s*"POST"\s*\}\)/,
    "upload must not fire a body-less /api/jobs/process call",
  );
});

test("jobs/process route removes the silent demo fallback for real backends", () => {
  const source = read("app/api/jobs/process/route.ts");
  assert.match(source, /resolveProcessingMode\s*\(/, "route must delegate the demo/process/unresolved decision");
  assert.match(source, /WORKSPACE_CONTEXT_UNRESOLVED/, "route must return an explicit unresolved-context error");
  assert.match(source, /status:\s*401/, "unresolved context must be a 401, not a silent 200/demo");
  // processDemoJobs must be gated behind the resolved "demo" mode, not called unconditionally on !context.
  assert.doesNotMatch(
    source,
    /if \(!context\) \{\s*return NextResponse\.json\(await processDemoJobs/,
    "processDemoJobs must not run unconditionally whenever context is missing",
  );
});

test("worker can resolve workspace context for a documentId of any job type", () => {
  const source = read("app/api/jobs/process/route.ts");
  // Direct document → workspace resolution (works for upload/ocr/extraction, not just conversion).
  assert.match(
    source,
    /processRequest\.documentId[\s\S]*?\.from\("documents"\)[\s\S]*?\.eq\("id",\s*processRequest\.documentId\)/,
    "getServiceRoleContextForJob must resolve a documentId directly from the documents table",
  );
  // The old conversion-only gate on the primary lookup must be gone.
  assert.doesNotMatch(source, /\.eq\("type",\s*"conversion"\)/, "documentId resolution must not be gated to conversion jobs");
});

test("failed processing marks the document with a clear failure status", () => {
  const source = read("app/api/jobs/process/route.ts");
  assert.match(source, /documentStatusOnJobFailure\s*\(/, "the catch path must set a failure status via the tested helper");
});

test("workspace shell poll advances each active document by id (no context-less poll)", () => {
  const source = read("components/documents/document-workspace-shell.tsx");
  assert.match(
    source,
    /body:\s*JSON\.stringify\(\{\s*documentId:\s*document\.id\s*\}\)/,
    "the live-status poll must target /api/jobs/process with a concrete documentId",
  );
  assert.doesNotMatch(
    source,
    /void fetch\("\/api\/jobs\/process",\s*\{\s*method:\s*"POST"\s*\}\)/,
    "the poll must not fire a body-less /api/jobs/process call",
  );
});

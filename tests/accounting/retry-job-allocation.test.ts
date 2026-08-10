// Retry must be able to retry.
//
// A processing job is one execution attempt. The worker's claim accepts a job
// only when it is "queued", or "running" with a heartbeat that has gone cold;
// anything else is answered 409 "Processing job is not queued or reclaimable.
// Create a new job before retrying."
//
// Force Reprocess allocated a fresh job and so always worked. Retry re-sent
// whatever job the run already had — and a run only reaches the failure panel
// AFTER its attempt has finished, so that job is spent by definition. Retry was
// therefore guaranteed to 409 on exactly the runs it exists for, and because the
// refusal arrives only after the run has been marked processing and
// re-extracted, pressing it replaced the real failure reason with a message
// about job claiming. Production hit this on an FNB statement: the reviewer lost
// the diagnosis and had no working button.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { isDispatchableJobStatus } = await import("@/lib/accounting/run-status.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Statements in the route, with comments stripped so prose cannot satisfy a test. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const routeSource = read("app/api/accounting/fnb/process/route.ts");
const route = withoutComments(routeSource);

// ── The predicate ───────────────────────────────────────────────────────────

test("a spent attempt is not dispatchable", () => {
  for (const status of ["succeeded", "completed", "failed", "cancelled"]) {
    assert.equal(
      isDispatchableJobStatus(status),
      false,
      `a ${status} job has already had its turn; re-sending it is the 409 this fix exists to remove`,
    );
  }
});

test("a missing job is not dispatchable", () => {
  // A run whose job row is gone, or which never had one, used to get a 409 with
  // no route forward at all.
  assert.equal(isDispatchableJobStatus(null), false);
  assert.equal(isDispatchableJobStatus(undefined), false);
  assert.equal(isDispatchableJobStatus(""), false);
});

// This is the guard that makes the fix safe rather than merely effective. If
// "running" were treated as spent, every Retry against a live worker would
// allocate a replacement and supersede an attempt that was mid-write — the
// double pipeline the claim exists to prevent, reintroduced by the repair.
test("a running job is still dispatchable, so a live worker is never superseded", () => {
  assert.equal(
    isDispatchableJobStatus("running"),
    true,
    "the worker answers already_running without scheduling a second pipeline, or reclaims a dead one; both are correct",
  );
});

test("a queued job is dispatchable", () => {
  assert.equal(isDispatchableJobStatus("queued"), true);
});

test("status matching does not depend on the database's casing", () => {
  assert.equal(isDispatchableJobStatus("QUEUED"), true);
  assert.equal(isDispatchableJobStatus("Running"), true);
  assert.equal(isDispatchableJobStatus("FAILED"), false);
});

test("an unrecognised status is treated as spent", () => {
  // Fails towards allocating a fresh job, which is recoverable. The opposite
  // default re-sends a job the worker will refuse.
  assert.equal(isDispatchableJobStatus("paused"), false);
});

// ── The route ───────────────────────────────────────────────────────────────

test("allocation is decided by whether a job can be claimed, not by which button was pressed", () => {
  assert.match(
    route,
    /allocatedReplacementJob = body\.reprocess/,
    "Force Reprocess must still always take a fresh job",
  );
  assert.match(
    route,
    /isDispatchableJobStatus\(/,
    "Retry must consult the job's real state instead of assuming its own job is reusable",
  );
  assert.doesNotMatch(
    route,
    /if \(body\.reprocess\) \{\s*const \{ data: replacementJobId/,
    "gating allocation on body.reprocess alone is the defect: it leaves Retry re-sending a spent job",
  );
});

test("the replacement is still created by the one atomic RPC", () => {
  // Retry now allocates jobs too, so it inherits the same constraint Force
  // Reprocess had: an insert outside the RPC races the one-active-job index.
  assert.match(route, /rpc\(\s*"begin_accounting_reprocess"/);
  assert.doesNotMatch(
    route,
    /from\("processing_jobs"\)\s*\.insert\(/,
    "a replacement insert outside the RPC races processing_jobs_one_active_per_doc_type",
  );
});

test("job_superseded_at records what actually happened, not which button was pressed", () => {
  assert.match(
    route,
    /job_superseded_at: allocatedReplacementJob \?/,
    "a Retry that retires a previous job has superseded it, and the audit trail must say so",
  );
  assert.doesNotMatch(
    route,
    /job_superseded_at: body\.reprocess \?/,
    "tying supersession to the flag understates a Retry that replaced a job",
  );
});

test("only a job this request created may be marked failed on cleanup", () => {
  // The cleanup branch previously keyed on body.reprocess, which was equivalent
  // to "we created this job". Now that Retry can create one too, the condition
  // has to be the allocation itself — otherwise a failure path could retire a
  // job it merely inherited from a still-running attempt.
  const cleanup = route.slice(route.indexOf("if (fallbackMarkError)"), route.indexOf("return NextResponse.json({ error: fallbackMarkError.message }"));
  assert.match(cleanup, /if \(allocatedReplacementJob\)/);
  assert.doesNotMatch(cleanup, /if \(body\.reprocess\)/);
});

test("an unreadable job state does not supersede anything", () => {
  // Fails SAFE rather than closed. If the job's status cannot be read, the
  // existing id is kept and the worker's claim — the authority — decides.
  // Allocating on a failed read could supersede a job that is alive.
  assert.match(
    route,
    /!existingJobError && !isDispatchableJobStatus/,
    "a read error must not be mistaken for a spent job",
  );
});

// The two buttons must stay genuinely different. Retry means "try again with
// what we extracted"; Force Reprocess means "throw that away and re-read the
// PDF". If allocating a job for both had collapsed that distinction, Retry would
// silently have become the expensive path.
test("Retry still reuses the extraction cache and Force Reprocess still bypasses it", () => {
  assert.match(
    route,
    /processStatementInBackground\([^)]*Boolean\(body\.reprocess\)\)/,
    "cache bypass must remain tied to reprocess, not to whether a job was allocated",
  );
});

test("a run already processing is still left alone unless forced", () => {
  assert.match(
    route,
    /status === "processing" && !body\.reprocess/,
    "the cheap first line against doomed dispatches must survive",
  );
});

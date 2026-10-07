import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/accounting/fnb/process/route.ts", "utf8");

test("the claim asks for the rows it affected", () => {
  // PostgREST does not error when a conditional UPDATE matches nothing — it
  // returns success with zero rows. Without .select() there is no way to tell a
  // landed claim from a silent no-op, and supabase-js returns no row count.
  // Both the primary claim and its fallback must ask, or one path stays blind.
  const claimFilters = route.match(/\.or\(`active_job_id\.is\.null[^\n]*\n\s*\.select\("id"\)/g) ?? [];
  assert.equal(claimFilters.length, 2, "both the claim and its fallback must select their affected rows");
});

test("an unclaimed run is refused before anything expensive happens", () => {
  // The cost of getting this wrong is not a failed request. The worker extracts,
  // classifies ~500 transactions across ~18 model calls and reconciles — several
  // minutes — and only then does replace_accounting_transactions_owned reject the
  // write, because migration 026 requires the ownership the claim never recorded.
  // Every second of that is discarded, and nothing errors, so the run just looks
  // slow.
  assert.ok(/claimLanded/.test(route), "the claim result is tracked");
  assert.ok(
    /if \(!claimLanded\)[\s\S]{0,1200}status: 409/.test(route),
    "an unclaimed run returns 409 rather than dispatching",
  );
});

test("the refusal reports the state that blocked it", () => {
  // A generic failure would leave the next occurrence needing the same
  // investigation: Render logs, a Supabase query and a code trace. The refusal
  // carries status, active_job_id and processing_job_id so it diagnoses itself.
  const refusal = route.slice(route.indexOf("claim matched no rows"));
  for (const field of ["currentStatus", "currentActiveJobId", "currentProcessingJobId", "jobAcceptedAt"]) {
    assert.ok(refusal.includes(field), `the log must record ${field}`);
  }
});

test("dispatch happens only after the claim is verified", () => {
  // Ordering is the whole point: the check must sit between the claim and the
  // handoff, not after it.
  const claimIndex = route.indexOf("if (!claimLanded)");
  const dispatchIndex = route.indexOf("processStatementInBackground(context");
  assert.ok(claimIndex > 0 && dispatchIndex > 0);
  assert.ok(claimIndex < dispatchIndex, "the claim check must precede dispatch");
});

test("the fence the claim feeds still requires real ownership", () => {
  // The claim exists to satisfy this. If the migration ever stops requiring
  // ownership, the verification above is guarding nothing.
  const migration = readFileSync("supabase/migrations/026_accounting_attempt_fencing.sql", "utf8");
  assert.ok(/current_job_id is distinct from p_job_id/.test(migration));
  assert.ok(/current_status <> 'processing'/.test(migration));
});

test("the claim never writes null into parser_debug", () => {
  // Production's parser_debug is NOT NULL DEFAULT '{}'. The claim reset it to
  // null, so the primary claim failed on every run; the run then hung on
  // "Reconciling" with nothing persisted (release audit, 2026-10-07).
  assert.doesNotMatch(route, /parser_debug:\s*null/, "reset parser_debug to {}, never null");
  assert.doesNotMatch(route, /parser_debug:\s*parserDebug\s*\?\?\s*null/, "failRun must fall back to {}, not null");
});

test("the fallback claim records ownership, not just status", () => {
  // The fallback used to set status/processing_job_id only. It matched the row,
  // so claimLanded was true and the job dispatched — but with active_job_id
  // still null, replace_accounting_transactions_owned rejected the worker's
  // final write. A claim without ownership must not count as landed.
  const fallback = route.slice(route.indexOf("fallbackClaimedRows, error: fallbackMarkError"));
  const updateBlock = fallback.slice(0, fallback.indexOf(".eq(\"workspace_id\""));
  assert.match(updateBlock, /active_job_id:\s*processingJobId/, "the fallback claim must set active_job_id");
});

test("a failed primary claim is logged with its database error", () => {
  // The constraint violation above was invisible in the app's logs: the error
  // was consumed by the fallback without a trace.
  const failure = route.slice(route.indexOf("if (markError) {"));
  assert.match(failure.slice(0, 400), /console\.error\([\s\S]*markError\.message/, "log the primary claim error");
});

test("a superseded attempt cannot mark the run failed", () => {
  // Release audit, 2026-10-07: a Retry and two Force Reprocesses raced. The two
  // superseded attempts' failRun wrote status "failed" by run id alone, after a
  // newer job owned the run — and replace_accounting_transactions_owned (030)
  // requires status 'processing', so the newer job's finished ledger was
  // rejected too. Every terminal write in failRun must be fenced on its job.
  const failRun = route.slice(route.indexOf("const failRun = async"), route.indexOf("const workerEndpoint"));
  const runUpdates = failRun.split('.from("accounting_statement_runs")').length - 1;
  const fenced = (failRun.match(/ownedRun\(\s*context\.supabase\s*\.from\("accounting_statement_runs"\)/g) ?? []).length;
  assert.ok(runUpdates >= 2, "failRun writes the run's failure");
  assert.equal(fenced, runUpdates, "every run update in failRun goes through the job fence");
  assert.match(failRun, /query\.eq\("active_job_id", jobId\)/, "the fence is this attempt's job");
});

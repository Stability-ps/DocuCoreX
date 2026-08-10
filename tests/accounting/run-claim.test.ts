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

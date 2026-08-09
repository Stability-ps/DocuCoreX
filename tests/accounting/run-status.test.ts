// "queued" means uploaded and waiting for someone to ask for processing; it
// does not mean work is underway.
//
// server.ts:504 inserts the run as "queued" at UPLOAD, and the process route
// only moves it to "processing" when work actually starts — uploading is not
// the same act as asking for processing. Conflating the two produced a
// production report of a "stuck pipeline": a run nobody had processed showed a
// "Processing… waiting for the latest accounting results." banner and a
// pipeline frozen on "Detecting PDF type", while the UI polled it 102 times
// waiting for a transition that could never come. Nothing was stuck. Nothing
// had been started.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register("../pdf/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { isActiveRunStatus, isRunInFlight, isRunAwaitingProcessing, isTerminalRunStatus } = await import(
  "@/lib/accounting/run-status.ts"
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("a queued run is NOT in flight", () => {
  assert.equal(isRunInFlight("queued"), false, "an upload nobody has processed is not work in progress");
  assert.equal(isRunAwaitingProcessing("queued"), true);
});

test("a processing run is in flight", () => {
  assert.equal(isRunInFlight("processing"), true);
  assert.equal(isRunAwaitingProcessing("processing"), false);
});

test("queued is still active and still non-terminal", () => {
  // The lifecycle answer is unchanged: a queued run is not finished, so
  // cancelling it is legitimate and pollers must not treat it as done.
  assert.equal(isActiveRunStatus("queued"), true);
  assert.equal(isTerminalRunStatus("queued"), false);
});

test("terminal states are neither in flight nor awaiting processing", () => {
  for (const status of ["completed", "failed", "review", "cancelled"]) {
    assert.equal(isRunInFlight(status), false, status);
    assert.equal(isRunAwaitingProcessing(status), false, status);
    assert.equal(isTerminalRunStatus(status), true, status);
  }
});

test("the processing banner and pipeline are driven by in-flight, not active", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  // The live-refresh state decides both the "Processing…" banner and whether
  // polling continues. Driving it from isActiveRunStatus is the regression.
  assert.doesNotMatch(
    ui,
    /setLiveRefreshState\(isActiveRunStatus/,
    "the processing banner must not treat a queued upload as work in progress",
  );
  assert.match(ui, /setLiveRefreshState\(isRunInFlight/);
  assert.match(ui, /isRunInFlight\(detail\.run\.status\) \? \(/, "the Processing in progress panel is gated on real work");
});

test("a queued run offers the explicit Process action", () => {
  const ui = read("components/accounting/accounting-intelligence.tsx");
  assert.match(ui, /isRunAwaitingProcessing\(detail\.run\.status\)/, "queued runs get their own state");
  assert.match(ui, /Ready to process/, "and say what they are waiting for");
});

// ── Job ownership ───────────────────────────────────────────────────────────
//
// Once the worker accepts a job it owns the outcome. The caller's timeout,
// disconnect or after() ending must not turn finished work into a failure —
// which is exactly what happened at 254s while extraction had succeeded.

const { isRunStalled, STALE_PROGRESS_THRESHOLD_MS } = await import("@/lib/accounting/run-status.ts");

test("a run with no acceptance is never stalled", () => {
  // Dispatch never completed, so there is nothing to be stalled — this is a
  // dispatch failure, which the caller owns and reports directly.
  assert.equal(isRunStalled("processing", null, null, Date.now()), false);
});

test("an accepted run that stopped moving is stalled", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 60_000).toISOString();
  assert.equal(isRunStalled("processing", longAgo, longAgo, now), true);
});

test("progress writes keep a slow statement out of the stalled state", () => {
  const now = Date.now();
  const acceptedLongAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 600_000).toISOString();
  const movedRecently = new Date(now - 30_000).toISOString();
  assert.equal(isRunStalled("processing", acceptedLongAgo, movedRecently, now), false);
});

test("only in-flight runs can be stalled", () => {
  const now = Date.now();
  const longAgo = new Date(now - STALE_PROGRESS_THRESHOLD_MS - 60_000).toISOString();
  for (const status of ["queued", "completed", "failed", "review", "cancelled"]) {
    assert.equal(isRunStalled(status, longAgo, longAgo, now), false, status);
  }
});

test("an accepted job is never failed by the caller", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /if \(jobAccepted\) \{/, "failRun must bail once the worker owns the job");
  assert.match(route, /not failing an accepted job/);
  assert.match(route, /kind: "accepted"/, "202 is a distinct outcome from synchronous success");
});

test("dispatch goes to the dispatch endpoint and claims the run", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.match(route, /buildWorkerEndpoint\(workerUrl, "\/process-statement\/dispatch"\)/);
  assert.match(route, /active_job_id: detail\.run\.processingJobId/, "the run must claim the job before dispatch");
  assert.match(route, /job_accepted_at: new Date\(\)\.toISOString\(\)/, "acceptance is recorded");
});

test("worker writes are fenced and stale ones rejected", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /class StaleJobError/);
  assert.match(worker, /query\.eq\("active_job_id", job_id\)/, "updates are conditional on owning the run");
  assert.match(worker, /worker\.run_update_rejected_stale_job/, "a rejected write is logged, not swallowed");
  assert.match(worker, /@app\.post\("\/process-statement\/dispatch", status_code=202\)/);
  assert.match(worker, /@app\.post\("\/process-statement"\)/, "the synchronous endpoint stays available");
});

// ── Job claim ───────────────────────────────────────────────────────────────
//
// active_job_id fences a SUPERSEDED job — a different id — out of a run. It
// cannot stop the SAME id being dispatched twice, because both writers satisfy
// "active_job_id = mine". Production did exactly that: job f1d9d778 for run
// 1ee084e3 was accepted at 16:23 and again at 16:42.
//
// Two pipelines on one run is worse than duplicate rows: transactions are
// written delete-then-insert keyed on run_id, so one worker's DELETE can land
// between the other's DELETE and INSERT and destroy completed results.

test("dispatch claims the job atomically before scheduling", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /def _claim_processing_job/);
  // The claim IS a conditional UPDATE, so concurrent dispatches serialise on
  // it. Claimable when queued, or when running but the heartbeat has gone cold
  // — the reclaim clause added after a dead worker stranded a job permanently.
  assert.match(worker, /\.update\(\{"status": "running"[\s\S]{0,240}?status\.eq\.queued,and\(status\.eq\.running/);
  assert.match(worker, /if not _claim_processing_job\(payload\.processing_job_id\)/, "claim gates the dispatch");
});

test("an unclaimable job is reported running and schedules nothing", () => {
  const worker = read("workers/accounting_worker/main.py");
  const dispatch = worker.slice(worker.indexOf("def dispatch_statement"));
  const alreadyRunning = dispatch.slice(0, dispatch.indexOf("background.add_task"));
  assert.match(alreadyRunning, /"already_running": True/, "the repeat dispatch is answered honestly");
  assert.match(alreadyRunning, /return \{/, "and returns BEFORE add_task is reached");
});

test("the claim fails closed", () => {
  const worker = read("workers/accounting_worker/main.py");
  const claim = worker.slice(worker.indexOf("def _claim_processing_job"), worker.indexOf("class _LivenessHeartbeat"));
  assert.match(claim, /except Exception/);
  assert.match(claim, /return False/, "an unevaluable claim must refuse, never schedule");
  assert.match(claim, /worker\.dispatch_claim_failed/, "and say so");
});

test("already_running still counts as the worker owning the job", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  const branch = route.slice(route.indexOf("if (response.status === 202)"));
  assert.match(branch.slice(0, 400), /jobAccepted = true/, "a repeat dispatch must not be failed by the caller");
});

// ── The stuck sweeper must respect ownership ────────────────────────────────
//
// markRunStuckIfNeeded runs on READ and writes status:"failed". It knew nothing
// about job ownership, so it reintroduced through the read path the exact defect
// #79 removed from the dispatch path: a run marked failed while the worker was
// still working. Production hit it — "Processing stale — no heartbeat update for
// 10 minutes" on a 37-page, 613-transaction statement the worker had accepted.

test("an accepted run is never failed by the read-path sweeper", () => {
  const server = read("lib/accounting/server.ts");
  const sweeper = server.slice(server.indexOf("async function markRunStuckIfNeeded"));
  const guards = sweeper.slice(0, sweeper.indexOf("const reason = processingStuckReason"));
  assert.match(guards, /if \(row\.job_accepted_at\) return row;/, "the worker owns an accepted job's terminal state");
});

test("a queued run is never failed for taking too long", () => {
  // Queued means waiting for someone to press Process (#78). It has not started,
  // so it cannot be stuck, and may legitimately sit for days.
  const server = read("lib/accounting/server.ts");
  const sweeper = server.slice(server.indexOf("async function markRunStuckIfNeeded"));
  const guards = sweeper.slice(0, sweeper.indexOf("const reason = processingStuckReason"));
  assert.match(guards, /if \(row\.status === "queued"\) return row;/);
});

test("an unowned processing run can still be failed", () => {
  // Dispatch died before the worker took the job: nobody owns it, nobody else
  // will resolve it. That one remains Vercel's to fail.
  const server = read("lib/accounting/server.ts");
  const sweeper = server.slice(server.indexOf("async function markRunStuckIfNeeded"));
  assert.match(sweeper, /status: "failed"/, "the unowned case is still handled");
  assert.match(sweeper, /processing_step: "Stuck \/ Needs retry"/);
});

// ── Atomic transaction replace ──────────────────────────────────────────────
//
// The delete and the insert used to be two PostgREST calls with nothing between
// them. A crash in that window — deploy, OOM kill, restart — left the run with
// ZERO transactions: the whole ledger gone, no error recorded, the run still
// reading as processed. Concurrency was never the issue here; active_job_id and
// the processing_jobs claim already cover that. This is the crash window.

test("transactions are replaced through the atomic RPC", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /def replace_transactions/);
  assert.match(worker, /supabase\.rpc\(\s*"replace_accounting_transactions"/, "one call, one transaction");
  assert.match(
    worker,
    /provenance_persisted = replace_transactions\(/,
    "the write path must go through the atomic replace",
  );
});

test("the delete is no longer a bare separate call on the happy path", () => {
  const worker = read("workers/accounting_worker/main.py");
  const replace = worker.slice(worker.indexOf("def replace_transactions"), worker.indexOf("def insert_transactions"));
  // The only remaining delete-then-insert is inside the documented fallback,
  // after the RPC has been found missing.
  assert.match(replace, /except Exception/);
  assert.match(replace, /atomic_replace_unavailable/, "the fallback is logged, not silent");
  const beforeFallback = replace.slice(0, replace.indexOf("except Exception"));
  assert.doesNotMatch(beforeFallback, /\.delete\(\)/, "the happy path must not delete separately");
});

test("the function body is what provides atomicity", () => {
  const migration = read("supabase/migrations/025_atomic_transaction_replace.sql");
  assert.match(migration, /create or replace function public\.replace_accounting_transactions/);
  assert.match(migration, /delete from public\.accounting_transactions/);
  assert.match(migration, /insert into public\.accounting_transactions/);
  assert.match(migration, /language plpgsql/, "a function body is one implicit transaction");
});

test("the replace is scoped by workspace, not just run", () => {
  const migration = read("supabase/migrations/025_atomic_transaction_replace.sql");
  const body = migration.slice(migration.indexOf("delete from public.accounting_transactions"));
  assert.match(body.slice(0, 200), /and workspace_id = p_workspace_id/, "a service-role key must not cross workspaces");
  assert.match(migration, /revoke all on function[\s\S]*from public/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
});

// ── Heartbeat fencing ───────────────────────────────────────────────────────
//
// heartbeat_step was the one worker write that ignored active_job_id. A
// superseded job kept stamping processing_step and updated_at onto a run it no
// longer owned — overwriting the new job's stage label and refreshing the
// liveness signal on its behalf, which is precisely the signal the stale
// detector reads.

test("the heartbeat is fenced by the job that owns the run", () => {
  const worker = read("workers/accounting_worker/main.py");
  const hb = worker.slice(worker.indexOf("def heartbeat_step"), worker.indexOf("def heartbeat_step") + 2000);
  const runUpdate = hb.slice(0, hb.indexOf('supabase.table("processing_jobs")'));
  assert.match(runUpdate, /job_id=processing_job_id/, "the heartbeat must identify its job");
});

test("an unclaimed run is not treated as superseded", () => {
  // active_job_id NULL means never claimed — a pre-024 row, or the legacy
  // synchronous endpoint. Refusing those would kill healthy jobs.
  const worker = read("workers/accounting_worker/main.py");
  const hb = worker.slice(worker.indexOf("def heartbeat_step"), worker.indexOf("def heartbeat_step") + 2000);
  assert.match(hb, /allow_unclaimed=True/);
  assert.match(worker, /active_job_id\.eq\.\{job_id\},active_job_id\.is\.null/, "only a DIFFERENT id is a supersession");
});

test("result writes stay strictly fenced", () => {
  // allow_unclaimed is for liveness only. A run's RESULTS must never be written
  // by a job that does not own it, unclaimed or otherwise.
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /allow_unclaimed: bool = False/, "strict fencing remains the default");
});

// ── Liveness is not progress ────────────────────────────────────────────────
//
// Heartbeats used to be written only at the seven stage boundaries, so the
// freshest liveness signal a run had was "the stage last changed". A stage that
// legitimately runs long — classification is ~21 model round trips for a
// 613-transaction statement — looked identical to a dead worker, and the run
// was failed at 10 minutes while healthy. Stale must mean loss of liveness,
// not absence of progress.

test("a ticker keeps liveness fresh independently of stage changes", () => {
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /class _LivenessHeartbeat/);
  assert.match(worker, /LIVENESS_TICK_SECONDS = \d+/);
  assert.match(worker, /\.table\("processing_jobs"\)[\s\S]{0,200}?"updated_at"/, "liveness is processing_jobs.updated_at");
});

test("the ticker cannot outlive the work", () => {
  // A leaked ticker keeps a dead job looking alive forever — the inverse bug,
  // and harder to notice. The stop is in __exit__, so the context manager
  // guarantees it.
  const worker = read("workers/accounting_worker/main.py");
  assert.match(worker, /with _LivenessHeartbeat\([\s\S]{0,120}?process_fnb_statement/, "scoped to the pipeline call");
  assert.match(worker, /def __exit__[\s\S]{0,200}?self\._stop\.set\(\)/);
});

test("the ticker stops rather than heartbeating for a superseded job", () => {
  const worker = read("workers/accounting_worker/main.py");
  const hb = worker.slice(worker.indexOf("class _LivenessHeartbeat"), worker.indexOf("def _run_dispatched_job"));
  assert.match(hb, /_still_owns_run/, "ownership is rechecked before each tick");
  assert.match(hb, /active is None or active == self\._job_id/, "NULL means unclaimed, not superseded");
  assert.match(hb, /worker\.liveness_superseded/);
});

test("the sweeper judges liveness by the job heartbeat, not the run's stage", () => {
  const server = read("lib/accounting/server.ts");
  assert.match(server, /livenessAtIso\?: string \| null/);
  assert.match(server, /\.from\("processing_jobs"\)[\s\S]{0,160}?select\("updated_at"\)/, "reads the job's heartbeat");
  assert.match(server, /processingStuckReason\(row, livenessAt\)/);
  // And says something true when it does fire.
  assert.match(server, /no worker heartbeat for/);
  assert.doesNotMatch(server, /no heartbeat update for \$\{minutes\} minutes\. Marked as stuck/, "the old stage-based wording is gone");
});

// ── The claim must be reclaimable ───────────────────────────────────────────
//
// The original claim was a one-way door: it marked 'running' and nothing ever
// set it back, so a worker lost to a restart or deploy left the job permanently
// unclaimable — every retry answered already_running, nothing scheduled, the run
// stuck in processing forever. Production hit it: job 35982d77 was claimed at
// 17:20, its worker died in a deploy, and an hour later dispatches were still
// being refused.

test("a dead job can be reclaimed once its heartbeat goes cold", () => {
  const worker = read("workers/accounting_worker/main.py");
  const claim = worker.slice(worker.indexOf("def _claim_processing_job"), worker.indexOf("class _LivenessHeartbeat"));
  assert.match(claim, /STALE_CLAIM_RECLAIM_SECONDS/);
  assert.match(
    claim,
    /status\.eq\.queued,and\(status\.eq\.running,updated_at\.lt\./,
    "claimable when queued OR running-but-silent",
  );
});

test("the reclaim window is several missed heartbeats, not one", () => {
  const worker = read("workers/accounting_worker/main.py");
  const tick = Number(worker.match(/LIVENESS_TICK_SECONDS = (\d+)/)?.[1]);
  const reclaim = Number(worker.match(/STALE_CLAIM_RECLAIM_SECONDS = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(tick) && Number.isFinite(reclaim));
  assert.ok(
    reclaim >= tick * 4,
    `reclaim (${reclaim}s) must tolerate several missed ticks (${tick}s) or a slow beat gets a live job stolen`,
  );
});

test("the claim is still a single atomic update", () => {
  // Two dispatches must not both win. The reclaim clause widens WHICH rows are
  // claimable; it must not turn the claim into read-then-write.
  const worker = read("workers/accounting_worker/main.py");
  const claim = worker.slice(worker.indexOf("def _claim_processing_job"), worker.indexOf("class _LivenessHeartbeat"));
  assert.match(claim, /\.update\(\{"status": "running"/);
  assert.doesNotMatch(claim, /\.select\(/, "no read-then-write; the UPDATE itself is the lock");
  assert.match(claim, /except Exception[\s\S]*return False/, "still fails closed");
});

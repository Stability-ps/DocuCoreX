import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Processing is a decision, not a side effect.
 *
 * Three paths used to start an eleven-minute extraction with no user action:
 *
 *   accounting-intelligence.tsx  a useEffect that reprocessed any run whose
 *                                saved totals looked stale
 *   statement-workspace.tsx      the same effect, duplicated, on opening a
 *                                statement
 *   accounting-intelligence.tsx  autoProcess(), immediately after upload
 *
 * The first two were guarded by a useRef, which lives on a mounted component.
 * That stops a loop inside one session and stops nothing across logins,
 * navigations, refreshes or remounts — every page load re-armed it. And while
 * the closing balance was NULL the staleness test was permanently true (the
 * difference computed as the whole opening balance, R992,452.57, against a
 * R1,000 threshold), so opening the page was enough to start work. Before #57
 * that work deleted the ledger before it began.
 *
 * These assertions read the components' source. The alternative is mounting
 * React with a faked fetch, a faked Supabase client, a faked router and faked
 * realtime channels, and a test resting on four fakes largely proves the fakes
 * agree with one another. The invariant is structural — "no render path reaches
 * a write" — so it is checked structurally.
 */

const INTELLIGENCE = "components/accounting/accounting-intelligence.tsx";
const WORKSPACE = "components/accounting/statement-workspace.tsx";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** Source with comments stripped, so prose about a defect is not mistaken for it. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** The body of every useEffect in a file, crudely but sufficiently extracted. */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  let index = source.indexOf("useEffect(");
  while (index !== -1) {
    let depth = 0;
    let end = index;
    for (let i = index + "useEffect(".length - 1; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    bodies.push(source.slice(index, end + 1));
    index = source.indexOf("useEffect(", end);
  }
  return bodies;
}

const WRITE_CALLS = [/processRun\s*\(/, /\breprocess\s*\(\s*\)/, /autoProcess\s*\(/];

// ── 1-8: nothing reachable from a render may start a job ────────────────────

test("no effect in Accounting Intelligence can start processing", () => {
  const bodies = effectBodies(code(INTELLIGENCE));
  assert.ok(bodies.length > 0, "the component still has effects to check");
  for (const body of bodies) {
    for (const call of WRITE_CALLS) {
      assert.doesNotMatch(body, call, `a useEffect calls ${call} — processing must not start from a render`);
    }
  }
});

test("no effect in the statement workspace can start processing", () => {
  const bodies = effectBodies(code(WORKSPACE));
  assert.ok(bodies.length > 0, "the component still has effects to check");
  for (const body of bodies) {
    for (const call of WRITE_CALLS) {
      assert.doesNotMatch(body, call, `a useEffect calls ${call} — opening a statement must be read-only`);
    }
  }
});

test("login, /accounting and ?run= load existing state only", () => {
  const source = code(INTELLIGENCE);
  // The mount effect restores selection from the URL and loads runs. Both are
  // reads; the assertion is that neither grew a write.
  const mountEffect = effectBodies(source).find((body) => body.includes('URLSearchParams') && body.includes("loadRuns"));
  assert.ok(mountEffect, "the ?run= restore effect still exists");
  assert.doesNotMatch(mountEffect, /processRun\s*\(/, "deep-linking to a run must not process it");
  assert.match(mountEffect, /loadRuns/, "it still loads existing state");
});

test("a browser reload cannot start a job", () => {
  // A reload is a remount, so the guarantee is exactly test 1 plus the absence
  // of the per-mount ref that used to make remounting re-arm the trigger.
  const source = code(INTELLIGENCE);
  assert.doesNotMatch(source, /autoReprocessedStaleRef/, "the per-mount guard is gone along with what it guarded");
  assert.doesNotMatch(source, /autoProcessedRef/, "the per-mount upload guard is gone too");
});

test("selecting a statement has no processing side effect", () => {
  const source = code(INTELLIGENCE);
  const selectFns = source.match(/function selectRun[\s\S]{0,600}?\n  \}/g) ?? [];
  for (const fn of selectFns) {
    assert.doesNotMatch(fn, /processRun\s*\(/, "selection must only select");
  }
});

test("detecting a stale extraction reports it and offers a button", () => {
  // The regression that motivated all of this: detection is read-only.
  const source = code(INTELLIGENCE);
  assert.match(source, /needsFreshExtraction && detail \?/, "the finding is rendered");
  assert.match(source, /may need reprocessing/i, "worded as a finding, not an action already underway");
  assert.match(
    source,
    /onClick=\{\(\) => void processRun\(detail\.run\.id, \{ reprocess: true \}\)\}/,
    "and correction is a button the user presses",
  );
  assert.doesNotMatch(source, /Refreshing this statement because/, "the old auto-refresh wording is gone");

  const workspace = code(WORKSPACE);
  assert.doesNotMatch(workspace, /Refreshing stale extraction/, "the workspace no longer claims a refresh is happening");
});

test("polling refreshes data without starting a second job", () => {
  const pollingEffect = effectBodies(code(INTELLIGENCE)).find((body) => body.includes("setInterval"));
  assert.ok(pollingEffect, "the poller still exists");
  assert.match(pollingEffect, /refreshAccountingData/, "it reads");
  for (const call of WRITE_CALLS) {
    assert.doesNotMatch(pollingEffect, call, "polling must never start work");
  }
});

test("a failed statement is never retried automatically", () => {
  // A failed run renders a panel WITH retry buttons. That is correct: the retry
  // is offered, not taken. The distinction that matters is whether the retry is
  // reachable from a render — so the assertion is that no effect mentions the
  // failed status alongside a write, and that the panel's retries arrive as
  // handler props rather than being invoked.
  for (const path of [INTELLIGENCE, WORKSPACE]) {
    for (const body of effectBodies(code(path))) {
      if (!/failed/.test(body)) continue;
      for (const call of WRITE_CALLS) {
        assert.doesNotMatch(body, call, `${path}: a failed status must not trigger a retry from an effect`);
      }
    }
  }

  // The panel itself must not fire its own retry on mount.
  const panel = code("components/accounting/failed-run-panel.tsx");
  assert.doesNotMatch(panel, /useEffect/, "the failed-run panel has no effects, so it cannot retry itself");
  assert.match(panel, /onClick=\{onRetry\}/, "retry is a click");
});

test("uploading a file does not start processing", () => {
  const source = code(INTELLIGENCE);
  assert.doesNotMatch(source, /autoProcess/, "post-upload auto-processing is gone");
  const uploadFiles = source.match(/async function uploadFiles[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(uploadFiles, "uploadFiles still exists");
  assert.doesNotMatch(uploadFiles, /processRun\s*\(/, "uploading stores the file; the user decides when to process");
});

// ── 9-12: the explicit paths still work ─────────────────────────────────────

test("Process starts exactly one job for that run", () => {
  const source = code(INTELLIGENCE);
  assert.match(source, /onClick=\{\(\) => void processRun\(detail\.run\.id\)\}/, "an explicit Process button exists");
  assert.match(source, /fetch\("\/api\/accounting\/fnb\/process"/, "and it posts to the processing route");
});

test("Process Selected posts only for the selected statements", () => {
  const source = code(INTELLIGENCE);
  const fn = source.match(/async function processSelectedRuns[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(fn, "processSelectedRuns exists");
  assert.match(fn, /selected/i, "it works from the selection, not from all runs");
  assert.match(source, /onClick=\{\(\) => void processSelectedRuns\(\)\}/, "and is reachable only by click");
});

test("Process All runs only after an explicit click", () => {
  const source = code(INTELLIGENCE);
  assert.match(source, /async function processAllRuns/, "processAllRuns exists");
  assert.match(source, /onClick=\{\(\) => void processAllRuns\(\)\}/, "and is reachable only by click");
  for (const body of effectBodies(source)) {
    assert.doesNotMatch(body, /processAllRuns\s*\(/, "never from an effect");
  }
});

test("Re-process Statement asks for a reprocess explicitly", () => {
  const workspace = code(WORKSPACE);
  assert.match(workspace, /onClick=\{\(\) => void reprocess\(\)\}/, "the workspace button is a click handler");
  assert.match(workspace, /body: JSON\.stringify\(\{ runId: statementId, reprocess: true \}\)/, "and it requests a reprocess");
  const intelligence = code(INTELLIGENCE);
  assert.match(intelligence, /processRun\(detail\.run\.id, \{ reprocess: true \}\)/, "the list view offers the same");
});

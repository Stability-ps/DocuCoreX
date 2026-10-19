// The scheduled sweep authenticates, finds stuck documents, and hands each to the
// worker within a time budget (lib/jobs/cron-sweep.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));
const { cronAuthorization, runCronSweep, SWEEP_MAX_DOCUMENTS } = await import("@/lib/jobs/cron-sweep.ts");
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the cron is refused without the exact bearer secret, and fails closed when unset", () => {
  assert.equal(cronAuthorization("Bearer s3cret-cron", "s3cret-cron"), "ok");
  assert.equal(cronAuthorization("bearer s3cret-cron", "s3cret-cron"), "ok");
  assert.equal(cronAuthorization("Bearer wrong", "s3cret-cron"), "invalid");
  assert.equal(cronAuthorization("s3cret-cron", "s3cret-cron"), "invalid", "a bare token is not a bearer credential");
  assert.equal(cronAuthorization(null, "s3cret-cron"), "invalid");
  assert.equal(cronAuthorization("Bearer anything", undefined), "unconfigured");
  assert.equal(cronAuthorization("Bearer anything", "  "), "unconfigured");
});

test("each stuck document is dispatched once, and outcomes are counted", async () => {
  const dispatched: string[] = [];
  const result = await runCronSweep({
    findDocumentIds: async () => ["a", "b", "a", "c"],
    dispatch: async (id) => {
      dispatched.push(id);
      if (id === "b") return { ok: false, status: 500 };
      if (id === "c") throw new Error("network");
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(dispatched, ["a", "b", "c"]);
  assert.deepEqual(result, { candidates: 3, dispatched: 3, succeeded: 1, failed: 2, skippedForTime: 0 });
});

test("the sweep stops starting work when the time budget runs low", async () => {
  let clock = 0;
  const result = await runCronSweep(
    {
      findDocumentIds: async () => ["a", "b", "c", "d"],
      dispatch: async () => {
        clock += 100_000;
        return { ok: true, status: 200 };
      },
      now: () => clock,
    },
    240_000,
  );
  assert.equal(result.dispatched, 3, "a fourth would start with 0s left");
  assert.equal(result.skippedForTime, 1);
});

test("each dispatch gets at most the remaining budget", async () => {
  const timeouts: number[] = [];
  let clock = 0;
  await runCronSweep(
    {
      findDocumentIds: async () => ["a", "b"],
      dispatch: async (_id, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += 150_000;
        return { ok: true, status: 200 };
      },
      now: () => clock,
    },
    240_000,
  );
  assert.deepEqual(timeouts, [120_000, 90_000]);
});

test("the batch is bounded", async () => {
  let asked = 0;
  await runCronSweep({ findDocumentIds: async (limit) => ((asked = limit), []), dispatch: async () => ({ ok: true, status: 200 }) });
  assert.equal(asked, SWEEP_MAX_DOCUMENTS);
});

test("GET authenticates before it touches the database, and the worker never sweeps", () => {
  const route = read("app/api/jobs/process/route.ts");
  const get = route.slice(route.indexOf("export async function GET(request: Request)"), route.indexOf("async function proxyToConversionWorker"));
  const auth = get.indexOf("cronAuthorization(request.headers.get(\"authorization\"), process.env.CRON_SECRET)");
  const admin = get.indexOf("createSupabaseServiceRoleClient()");
  assert.ok(auth > 0 && admin > auth, "the secret is checked before the service role is used");
  assert.match(get, /CONVERSION_WORKER_MODE === "true"\) \{\s+return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/);
  assert.match(get, /status: 503/, "fails closed without CRON_SECRET");
  // The only fall-through to POST is local demo mode, with no backend at all.
  assert.equal(get.split("return POST(").length - 1, 1);
  assert.match(get, /if \(!isSupabaseConfigured\) \{\s+return POST\(/, "POST is reachable only without Supabase");
  assert.match(read("vercel.json"), /"path": "\/api\/jobs\/process"/);
});

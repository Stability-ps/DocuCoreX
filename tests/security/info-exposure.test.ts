// Information exposure (F-21): worker hostnames, raw database errors and
// worker response bodies stay on the server.
//
// Sign-up is open, so anything a signed-in user can read, anyone can read.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { toPublicWorkerStatus } = await import("../../lib/system-worker-config.ts");
const { databaseErrorResponse } = await import("../../lib/api-errors.ts");

// ── /api/system/worker-config ────────────────────────────────────────────────

test("worker status for a signed-in user carries no hostname or URL", () => {
  const status = toPublicWorkerStatus({
    environment: "production",
    accountingWorker: { url: "https://accounting-internal.onrender.com", reachable: true, status: 200, error: null },
    // A fetch failure message names the host it could not resolve.
    conversionWorker: { url: "https://conversion-internal.onrender.com", reachable: false, status: null, error: "getaddrinfo ENOTFOUND conversion-internal.onrender.com" },
    pdfPlumber: { url: null, reachable: false, status: null, error: "not_configured" },
  });
  const body = JSON.stringify(status);
  assert.doesNotMatch(body, /onrender\.com|https?:\/\/|internal/);
  assert.equal(status.workerConfiguration.accountingWorkerConfigured, true);
  assert.equal(status.workerConfiguration.pdfPlumberConfigured, false);
  assert.equal(status.reachability.accountingWorker.reachable, true);
  assert.equal(status.reachability.conversionWorker.error, "unreachable", "the raw fetch error is reduced to a code");
  assert.equal(status.reachability.pdfPlumber.error, "not_configured");
});

test("an HTTP failure is reported by status code only", () => {
  const status = toPublicWorkerStatus({
    environment: "production",
    accountingWorker: { url: "https://a.example.com", reachable: false, status: 503, error: "http_503" },
    conversionWorker: { url: null, reachable: false, status: null, error: "not_configured" },
    pdfPlumber: { url: null, reachable: false, status: null, error: "not_configured" },
  });
  assert.equal(status.reachability.accountingWorker.error, "http_503");
  assert.doesNotMatch(JSON.stringify(status), /example\.com/);
});

test("the worker-config route builds its response from the public summary only", () => {
  const route = read("app/api/system/worker-config/route.ts");
  assert.match(route, /toPublicWorkerStatus\(reachability\)/);
  assert.doesNotMatch(route, /getWorkerConfig|WorkerUrl|pdfPlumberUrl/, "no URL field may reach the response");
});

test("the conversion debug route no longer reports the worker host or its raw health body", () => {
  const route = read("app/api/conversions/[id]/debug/route.ts");
  assert.doesNotMatch(route, /workerHost|safeHost/);
  assert.doesNotMatch(route, /\.\.\.body\b/, "the worker's health body must not be spread into the response");
  assert.doesNotMatch(route, /error: error instanceof Error \? error\.message/);
});

// ── Raw database errors ──────────────────────────────────────────────────────

test("databaseErrorResponse returns a generic message and a stable code", async () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const response = databaseErrorResponse(
      "docucorex.test.failed",
      { message: 'new row violates row-level security policy for table "api_keys"', code: "42501" },
      { message: "Unable to create API key." },
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: "Unable to create API key.", code: "DATABASE_ERROR" });
    assert.equal(logged[0]?.[0], "docucorex.test.failed", "the detail is logged server-side under the event name");
    assert.match(JSON.stringify(logged[0]?.[1]), /row-level security/);
  } finally {
    console.error = original;
  }
});

const CHANGED_ROUTES = [
  "app/api/accounting/fnb/process/route.ts",
  "app/api/accounting/fnb/runs/[id]/integrity/route.ts",
  "app/api/accounting/fnb/runs/[id]/source/route.ts",
  "app/api/ai/[documentId]/route.ts",
  "app/api/api-keys/route.ts",
  "app/api/audit-logs/route.ts",
  "app/api/comments/[documentId]/route.ts",
  "app/api/conversions/[id]/debug/route.ts",
  "app/api/conversions/route.ts",
  "app/api/documents/[id]/download/route.ts",
  "app/api/documents/[id]/preview/route.ts",
  "app/api/download-file/[downloadId]/route.ts",
  "app/api/downloads/[documentId]/route.ts",
  "app/api/jobs/process/route.ts",
  "app/api/jobs/route.ts",
  "app/api/pdf/analyze/[documentId]/route.ts",
  "app/api/profile/route.ts",
  "app/api/search/route.ts",
  "app/api/uploads/download-all/route.ts",
  "app/api/uploads/signed-url/route.ts",
  "app/api/uploads/workflow/route.ts",
  "app/api/usage/route.ts",
];

test("no changed route puts a Supabase error's .message into a response", () => {
  // Matches `{ error: someError.message }` / `someError?.message ?? "..."` inside
  // NextResponse.json(...) or downloadError(...), across line breaks.
  const leak = /(?:NextResponse\.json|downloadError)\(\s*(?:request,\s*)?(?:\{\s*error:\s*)?\w*[eE]rror\??\.message/;
  for (const path of CHANGED_ROUTES) {
    assert.doesNotMatch(read(path), leak, path);
  }
});

// ── Worker response bodies in logs ───────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

test("no worker or provider response body is logged", () => {
  for (const path of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    assert.doesNotMatch(read(path), /bodyPreview|responsePreview/, path);
  }
  const worker = read("workers/accounting_worker/main.py");
  assert.doesNotMatch(worker, /body=body_text/, "the accounting worker logs the provider error body's length, not its text");
});

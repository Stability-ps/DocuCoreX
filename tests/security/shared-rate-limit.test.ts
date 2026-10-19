// Rate limits are counted in Postgres so every server instance shares them (050),
// fall back to the per-process limiter when that is unavailable, and cover every
// route that can spend money or be abused.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const { consumeRateLimit, enforceRateLimit, rateLimitKey, clientIp, RATE_LIMITS } = await import("@/lib/shared-rate-limit.ts");

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(reply: (call: Call) => { data: unknown; error: { message: string; code?: string } | null } | Error) {
  const calls: Call[] = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      const call = { fn, args };
      calls.push(call);
      const result = reply(call);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

const request = (ip: string) => new Request("http://app.test/api/x", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });

test("uses the shared counter and passes the configured limit and window", async () => {
  const client = fakeClient(() => ({ data: [{ allowed: true, retry_after_ms: 0 }], error: null }));
  const decision = await consumeRateLimit("ocr", { workspaceId: "ws-1" }, client);
  assert.deepEqual(decision, { ok: true, retryAfterMs: 0, source: "shared" });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].fn, "consume_rate_limit");
  assert.equal(client.calls[0].args.p_limit, RATE_LIMITS.ocr.limit);
  assert.equal(client.calls[0].args.p_window_seconds, RATE_LIMITS.ocr.windowSeconds);
  assert.equal(client.calls[0].args.p_key, rateLimitKey("ocr", { workspaceId: "ws-1" }));
});

test("a refusal from the shared counter becomes a 429 with Retry-After", async () => {
  const client = fakeClient(() => ({ data: [{ allowed: false, retry_after_ms: 4200 }], error: null }));
  const response = await enforceRateLimit("ai", { workspaceId: "ws-1" }, undefined, client);
  assert.ok(response, "expected a response");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "5");
  const body = await response.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.ok(!JSON.stringify(body).includes("ws-1"), "the response must not name the limited identity");
});

test("an allowed request returns null so the route carries on", async () => {
  const client = fakeClient(() => ({ data: [{ allowed: true, retry_after_ms: 0 }], error: null }));
  assert.equal(await enforceRateLimit("search", { workspaceId: "ws-1" }, undefined, client), null);
});

for (const [label, reply] of [
  ["an RPC error (e.g. 050 not applied yet)", () => ({ data: null, error: { message: "function not found", code: "PGRST202" } })],
  ["a thrown network error", () => new Error("fetch failed")],
  ["an unexpected response shape", () => ({ data: { nope: true }, error: null })],
] as const) {
  test(`falls back to the per-process limiter on ${label}, and still limits`, async () => {
    const client = fakeClient(reply as () => { data: unknown; error: null });
    const identity = { workspaceId: `fallback-${label}` };
    const { limit } = RATE_LIMITS.apiKeyCreate;
    const decisions = [];
    for (let i = 0; i <= limit; i += 1) decisions.push(await consumeRateLimit("apiKeyCreate", identity, client));
    assert.ok(decisions.every((d) => d.source === "local"));
    assert.equal(decisions.filter((d) => d.ok).length, limit, "exactly `limit` allowed");
    assert.equal(decisions.at(-1)?.ok, false, "the next one is refused");
  });
}

test("with no service-role client at all, the per-process limiter applies", async () => {
  const decision = await consumeRateLimit("signin", { request: request("203.0.113.9") }, null);
  assert.equal(decision.source, "local");
  assert.equal(decision.ok, true);
});

test("keys hold a digest, never the raw IP or workspace id", () => {
  const byIp = rateLimitKey("signin", { request: request("203.0.113.9") });
  const byWorkspace = rateLimitKey("ocr", { workspaceId: "11111111-0000-0000-0000-000000000001" });
  assert.match(byIp, /^signin:ip:[0-9a-f]{32}$/);
  assert.match(byWorkspace, /^ocr:ws:[0-9a-f]{32}$/);
  assert.ok(!byIp.includes("203.0.113.9"));
  assert.ok(!byWorkspace.includes("11111111"));
});

test("keys separate limits, scopes and identities, and are stable", () => {
  const ws = { workspaceId: "ws-a" };
  assert.equal(rateLimitKey("ocr", ws), rateLimitKey("ocr", ws));
  assert.notEqual(rateLimitKey("ocr", ws), rateLimitKey("extraction", ws));
  assert.notEqual(rateLimitKey("ocr", ws), rateLimitKey("ocr", { workspaceId: "ws-b" }));
  // A workspace id that happens to equal an IP string must not share its bucket.
  assert.notEqual(rateLimitKey("upload", { workspaceId: "203.0.113.9" }), rateLimitKey("upload", { request: request("203.0.113.9") }));
  assert.ok(rateLimitKey("ocr", ws).length <= 200, "fits the SQL function's key limit");
});

test("a workspace identity wins over the request's IP", () => {
  assert.equal(
    rateLimitKey("ocr", { workspaceId: "ws-a", request: request("203.0.113.9") }),
    rateLimitKey("ocr", { workspaceId: "ws-a" }),
  );
});

test("clientIp takes the first forwarded address", () => {
  assert.equal(clientIp(request("198.51.100.7")), "198.51.100.7");
  assert.equal(clientIp(new Request("http://x/", { headers: { "x-real-ip": "198.51.100.8" } })), "198.51.100.8");
  assert.equal(clientIp(new Request("http://x/")), "unknown");
});

test("the processing limit sits well above the document list's own polling", () => {
  // document-workspace-shell polls up to 5 active documents every 2.5 s.
  const shell = read("components/documents/document-workspace-shell.tsx");
  assert.match(shell, /active\.slice\(0, 5\)/);
  assert.match(shell, /\}, 2500\);/);
  const pollPerMinute = 5 * (60_000 / 2500);
  assert.ok(RATE_LIMITS.processJobs.limit >= pollPerMinute * 4, `${RATE_LIMITS.processJobs.limit} leaves too little room over ${pollPerMinute}/min per tab`);
});

const ROUTES: Array<[string, string]> = [
  ["app/api/auth/signin/route.ts", "signin"],
  ["app/api/auth/signup/route.ts", "signup"],
  ["app/api/uploads/route.ts", "upload"],
  ["app/api/uploads/signed-url/route.ts", "signedUpload"],
  ["app/api/jobs/process/route.ts", "processJobs"],
  ["app/api/ocr/[documentId]/route.ts", "ocr"],
  ["app/api/extractions/[documentId]/route.ts", "extraction"],
  ["app/api/pdf/analyze/[documentId]/route.ts", "pdfAnalyze"],
  ["app/api/accounting/fnb/process/route.ts", "accountingProcess"],
  ["app/api/ai/[documentId]/route.ts", "ai"],
  ["app/api/search/route.ts", "search"],
  ["app/api/api-keys/route.ts", "apiKeyCreate"],
];

for (const [route, name] of ROUTES) {
  test(`${route} enforces the shared "${name}" limit`, () => {
    const source = read(route);
    assert.match(source, new RegExp(`enforceRateLimit\\("${name}"`), `${route} must call enforceRateLimit("${name}", …)`);
    assert.doesNotMatch(source, /checkRateLimit\(/, `${route} must not use the per-process limiter directly`);
  });
}

test("every limit name is used by a route", () => {
  const used = new Set(ROUTES.map(([, name]) => name));
  for (const name of Object.keys(RATE_LIMITS)) assert.ok(used.has(name), `${name} is defined but no route uses it`);
});

test("job processing limits callers, never the worker", () => {
  const route = read("app/api/jobs/process/route.ts");
  const branch = route.indexOf('if (process.env.CONVERSION_WORKER_MODE !== "true" && isSupabaseConfigured) {');
  const limit = route.indexOf('enforceRateLimit("processJobs"');
  const proxy = route.indexOf("await proxyToConversionWorker(request, processRequest)");
  assert.ok(branch > 0 && limit > branch && limit < proxy, "the limit is inside the caller-only branch, before the proxy");
});

test("paid-provider routes count only after authentication", () => {
  for (const route of ["app/api/pdf/analyze/[documentId]/route.ts", "app/api/accounting/fnb/process/route.ts"]) {
    const source = read(route);
    const unauthorized = source.indexOf('{ error: "Unauthorized" }, { status: 401 }');
    const limit = source.indexOf("enforceRateLimit(");
    assert.ok(unauthorized > 0 && limit > unauthorized, `${route}: an unauthenticated request must not consume a workspace's allowance`);
  }
});

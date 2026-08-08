// TEMPORARY (2026-08-06) — guards for the outbound half of the shared-secret
// comparison. Delete alongside the diagnostics themselves.
//
// The property that matters most here is NEGATIVE: the diagnostics must reveal
// nothing about the secret beyond its digest and length. A diagnostic that leaks
// the value it is measuring is worse than no diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { buildOutboundDiagnostics, sanitizeEndpoint, sha256, diagnosticsEnabled } = await import(
  "@/lib/accounting/workerAuthDiagnostics.ts"
);

const SECRET = "s3cret-token-value-abcdefghijklmnop";
const SECRET_SHA = createHash("sha256").update(SECRET).digest("hex");
const ENDPOINT = "https://docucorex.onrender.com/process-statement";

/** No substring of the secret, of any length ≥ 4, may appear in the output. */
function assertNoLeak(record: unknown, secret: string) {
  const blob = JSON.stringify(record);
  for (let n = 4; n <= secret.length; n += 1) {
    assert.ok(!blob.includes(secret.slice(0, n)), `leaked a ${n}-char prefix`);
    assert.ok(!blob.includes(secret.slice(-n)), `leaked a ${n}-char suffix`);
  }
}

test("emits the full digest and length, and nothing that reveals the token", () => {
  const d = buildOutboundDiagnostics({ rawToken: SECRET, workerEndpoint: ENDPOINT });
  assert.equal(d.token_sha256, SECRET_SHA);
  assert.equal(d.token_sha256?.length, 64, "full digest, not truncated");
  assert.equal(d.token_length, SECRET.length);
  assert.equal(d.token_present, true);
  assert.equal(d.authorization_header_added, true);
  assertNoLeak(d, SECRET);
});

test("the endpoint is reduced to a host — never a path that could carry an id", () => {
  assert.equal(sanitizeEndpoint(ENDPOINT), "docucorex.onrender.com");
  assert.equal(sanitizeEndpoint("not a url"), "unparseable");
  const d = buildOutboundDiagnostics({ rawToken: SECRET, workerEndpoint: ENDPOINT });
  assert.ok(!JSON.stringify(d).includes("process-statement"));
});

test("the digest is of the TRIMMED token, so it is comparable with the worker's", () => {
  // The worker hashes what parse_bearer extracted, which is already stripped.
  // Hashing the raw value here would make the two sides differ whenever
  // whitespace was present and tell us nothing about the failing comparison.
  const d = buildOutboundDiagnostics({ rawToken: `  ${SECRET}\n`, workerEndpoint: ENDPOINT });
  assert.equal(d.token_sha256, SECRET_SHA);
  assert.equal(d.token_length, SECRET.length);
  assert.equal(d.token_raw_length, SECRET.length + 3);
  assert.equal(d.token_had_surrounding_whitespace, true, "the stored value's whitespace is still reported");
});

test("an absent token is unambiguous — the case a silent header omission hid", () => {
  for (const raw of [undefined, "", "   "]) {
    const d = buildOutboundDiagnostics({ rawToken: raw, workerEndpoint: ENDPOINT });
    assert.equal(d.token_present, false, JSON.stringify(raw));
    assert.equal(d.token_sha256, null);
    assert.equal(d.token_length, 0);
    assert.equal(d.authorization_header_added, false);
  }
});

test("invisible and inner whitespace characters are flagged", () => {
  const zeroWidth = buildOutboundDiagnostics({ rawToken: `${SECRET}​`, workerEndpoint: ENDPOINT });
  assert.equal(zeroWidth.token_is_ascii, false, "a pasted zero-width space must be visible as non-ascii");
  assert.notEqual(zeroWidth.token_sha256, SECRET_SHA);

  const inner = buildOutboundDiagnostics({ rawToken: "tok en", workerEndpoint: ENDPOINT });
  assert.equal(inner.token_has_inner_whitespace, true, "inner whitespace breaks Bearer parsing on the worker");

  const clean = buildOutboundDiagnostics({ rawToken: SECRET, workerEndpoint: ENDPOINT });
  assert.equal(clean.token_is_ascii, true);
  assert.equal(clean.token_has_inner_whitespace, false);
});

test("sha256 is null-safe and stable", () => {
  assert.equal(sha256(null), null);
  assert.equal(sha256(undefined), null);
  assert.equal(sha256(SECRET), SECRET_SHA);
});

test("diagnostics have a kill switch that needs no deploy", () => {
  const previous = process.env.WORKER_AUTH_DIAGNOSTICS;
  try {
    delete process.env.WORKER_AUTH_DIAGNOSTICS;
    assert.equal(diagnosticsEnabled(), true, "on by default during the investigation");
    process.env.WORKER_AUTH_DIAGNOSTICS = "false";
    assert.equal(diagnosticsEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.WORKER_AUTH_DIAGNOSTICS;
    else process.env.WORKER_AUTH_DIAGNOSTICS = previous;
  }
});

test("the route refuses to call the worker unauthenticated", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const route = readFileSync(join(root, "app/api/accounting/fnb/process/route.ts"), "utf8");

  // The old form spread the header in conditionally, so an unset token produced
  // a request with NO Authorization at all — which the worker answers 401
  // "Missing Authorization header.", indistinguishable downstream from a wrong
  // value. That is the ambiguity that cost an investigation.
  assert.ok(
    !/\.\.\.\(process\.env\.ACCOUNTING_WORKER_TOKEN \? \{ Authorization/.test(route),
    "the conditional Authorization spread must not come back",
  );
  assert.match(route, /Authorization: `Bearer \$\{workerToken\}`/, "header is built from the trimmed token");
  assert.match(route, /kind: "config"/, "an absent token returns a config outcome before any request");
  assert.match(route, /Worker said: \$\{detail\}/, "the worker's own 401 detail is preserved, not discarded");
});

// ── /api/system/accounting-worker-runtime ────────────────────────────────────

const { buildRuntimeTokenReport } = await import("@/lib/accounting/workerAuthDiagnostics.ts");

const RUNTIME_ROUTE = "app/api/system/accounting-worker-runtime/route.ts";

test("runtime report returns only length and digest — never the token", () => {
  const report = buildRuntimeTokenReport({
    ACCOUNTING_WORKER_TOKEN: SECRET,
    ACCOUNTING_WORKER_URL: "https://docucorex.onrender.com",
    VERCEL_ENV: "preview",
    VERCEL_DEPLOYMENT_ID: "dpl_abc123",
    VERCEL_GIT_COMMIT_SHA: "deadbeef",
  } as NodeJS.ProcessEnv);

  assert.equal(report.token_present, true);
  assert.equal(report.token_length, SECRET.length);
  assert.equal(report.token_sha256, SECRET_SHA);
  assert.equal(report.token_sha256?.length, 64);
  assert.equal(report.accounting_worker_url, "https://docucorex.onrender.com");
  assert.equal(report.vercel_env, "preview");
  assert.equal(report.deployment_id, "dpl_abc123");
  assert.equal(report.commit_sha, "deadbeef");
  assertNoLeak(report, SECRET);

  // The response shape is closed: exactly these keys, so a future edit cannot
  // widen it into leaking something adjacent.
  assert.deepEqual(Object.keys(report).sort(), [
    "accounting_worker_url", "commit_sha", "deployment_id", "token_length",
    "token_present", "token_sha256", "vercel_env",
  ]);
});

test("an absent token reports present=false, length=0 and a null digest", () => {
  for (const raw of [undefined, "", "   "]) {
    const report = buildRuntimeTokenReport({ ACCOUNTING_WORKER_TOKEN: raw } as NodeJS.ProcessEnv);
    assert.equal(report.token_present, false, JSON.stringify(raw));
    assert.equal(report.token_length, 0);
    // Not the digest of "" — that would be a real-looking 64-char value for a
    // token that does not exist.
    assert.equal(report.token_sha256, null);
  }
});

test("the digest is of the trimmed token, matching what the worker hashes", () => {
  const report = buildRuntimeTokenReport({ ACCOUNTING_WORKER_TOKEN: `  ${SECRET}\n` } as NodeJS.ProcessEnv);
  assert.equal(report.token_sha256, SECRET_SHA, "directly comparable with the worker's received_sha256");
  assert.equal(report.token_length, SECRET.length);
});

test("no other secret is reachable through the report", () => {
  const report = buildRuntimeTokenReport({
    ACCOUNTING_WORKER_TOKEN: SECRET,
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "azure-secret-value",
    SUPABASE_SERVICE_ROLE_KEY: "supabase-secret-value",
    OPENAI_API_KEY: "openai-secret-value",
    CONVERSION_WORKER_SECRET: "conversion-secret-value",
  } as NodeJS.ProcessEnv);
  const blob = JSON.stringify(report);
  for (const secret of ["azure-secret-value", "supabase-secret-value", "openai-secret-value", "conversion-secret-value"]) {
    assert.ok(!blob.includes(secret), `leaked ${secret}`);
  }
});

test("the runtime endpoint requires an authenticated workspace", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const route = readFileSync(join(root, RUNTIME_ROUTE), "utf8");

  assert.match(route, /getWorkspaceContext\(\)/, "auth is checked");
  assert.match(route, /status:\s*401/, "unauthenticated callers get 401");
  // The auth check must come before the report is built, or an unauthenticated
  // caller could confirm a guessed token against the digest.
  assert.ok(
    route.indexOf("getWorkspaceContext") < route.indexOf("buildRuntimeTokenReport("),
    "auth must be checked before the digest is computed",
  );
  // Node runtime + per-request evaluation: node:crypto is unavailable on edge,
  // and a statically-optimized handler would defeat the endpoint's purpose.
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.ok(!/process\.env\.ACCOUNTING_WORKER_TOKEN/.test(route), "the route never touches the raw token itself");
});

test("outbound record carries the scheme and the configured worker URL", () => {
  const previousUrl = process.env.ACCOUNTING_WORKER_URL;
  try {
    process.env.ACCOUNTING_WORKER_URL = "https://docucorex.onrender.com";
    const d = buildOutboundDiagnostics({ rawToken: SECRET, workerEndpoint: ENDPOINT });
    assert.equal(d.authorization_scheme, "Bearer");
    assert.equal(d.accounting_worker_url, "https://docucorex.onrender.com");
    assert.equal(d.worker_endpoint, "docucorex.onrender.com", "endpoint stays host-only");
    assertNoLeak(d, SECRET);

    const absent = buildOutboundDiagnostics({ rawToken: undefined, workerEndpoint: ENDPOINT });
    assert.equal(absent.authorization_scheme, null, "no scheme when no header is sent");
    assert.equal(absent.authorization_header_added, false);
  } finally {
    if (previousUrl === undefined) delete process.env.ACCOUNTING_WORKER_URL;
    else process.env.ACCOUNTING_WORKER_URL = previousUrl;
  }
});

test("the outbound log is emitted immediately before fetch, server-side only", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const route = readFileSync(join(root, "app/api/accounting/fnb/process/route.ts"), "utf8");

  const logAt = route.indexOf("buildOutboundDiagnostics(");
  const fetchAt = route.indexOf("await fetch(workerEndpoint");
  assert.ok(logAt > 0 && fetchAt > 0, "both sites present");
  assert.ok(logAt < fetchAt, "the diagnostic must be logged before the request is made");

  // Server-side only: console, never a response body. The route's JSON responses
  // must not carry the digest to the browser.
  const between = route.slice(logAt, fetchAt);
  assert.ok(!/NextResponse|res\.json|return .*token_sha256/.test(between), "must not reach the browser");
  assert.match(route, /console\.info\(JSON\.stringify\(buildOutboundDiagnostics/);
});

// ── /api/system/worker-config extraction diagnostics ─────────────────────────

const { getExtractionConfig } = await import("@/lib/system-worker-config.ts");

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("extraction diagnostics report each Azure half separately", () => {
  // The exact production failure: key set, endpoint absent, so isAzureConfigured
  // is false and Azure was inert — with nothing saying WHICH half was missing.
  withEnv(
    { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: undefined, AZURE_DOCUMENT_INTELLIGENCE_KEY: "k", ACCOUNTING_SHADOW_AZURE: "true" },
    () => {
      const c = getExtractionConfig();
      assert.equal(c.azureDocumentIntelligence.configured, false);
      assert.equal(c.azureDocumentIntelligence.endpointPresent, false);
      assert.equal(c.azureDocumentIntelligence.keyPresent, true);
      assert.equal(c.shadowMode.enabled, true, "the flag is on...");
      assert.equal(c.shadowMode.effective, false, "...but useless without the endpoint");
    },
  );

  withEnv(
    { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://x.cognitiveservices.azure.com", AZURE_DOCUMENT_INTELLIGENCE_KEY: "k", ACCOUNTING_SHADOW_AZURE: "true" },
    () => {
      const c = getExtractionConfig();
      assert.equal(c.azureDocumentIntelligence.configured, true);
      assert.equal(c.azureDocumentIntelligence.endpointPresent, true);
      assert.equal(c.azureDocumentIntelligence.keyPresent, true);
      assert.equal(c.shadowMode.effective, true);
    },
  );
});

test("shadowMode.enabled matches the route's own gate exactly", () => {
  // The route tests === "true". Truthiness would disagree with the code it
  // describes, which is worse than not reporting it at all.
  for (const [value, expected] of [["true", true], ["TRUE", false], ["1", false], ["yes", false], [undefined, false]] as const) {
    withEnv({ ACCOUNTING_SHADOW_AZURE: value }, () => {
      assert.equal(getExtractionConfig().shadowMode.enabled, expected, `ACCOUNTING_SHADOW_AZURE=${String(value)}`);
    });
  }
});

test("no credential value can surface through the extraction diagnostics", () => {
  withEnv(
    {
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://secret-endpoint.example.com",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "azure-secret-key-value",
      MISTRAL_API_KEY: "mistral-secret-value",
      OPENAI_API_KEY: "openai-secret-value",
    },
    () => {
      const blob = JSON.stringify(getExtractionConfig());
      for (const s of ["azure-secret-key-value", "mistral-secret-value", "openai-secret-value", "secret-endpoint.example.com"]) {
        assert.ok(!blob.includes(s), `leaked ${s}`);
      }
    },
  );
});

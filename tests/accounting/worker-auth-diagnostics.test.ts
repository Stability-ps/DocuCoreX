// Worker-auth hygiene. The shared-secret investigation of 2026-08-06 added
// digest logging on both sides of the accounting-worker call and an endpoint
// that returned the token's SHA-256 to any signed-in user. The mismatch was
// resolved; these tests keep that scaffolding from coming back, and keep the
// fail-closed behaviour it uncovered.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { WorkerTokenMissingError } = await import("@/lib/accounting/workerToken.ts");

test("the token-digest endpoint is gone", () => {
  assert.equal(existsSync(join(root, "app/api/system/accounting-worker-runtime/route.ts")), false);
  assert.equal(existsSync(join(root, "lib/accounting/workerAuthDiagnostics.ts")), false);
});

test("neither side of the worker call logs a digest of the token", () => {
  const caller = read("app/api/accounting/fnb/process/route.ts");
  assert.ok(!/sha256|createHash|auth_outbound|WORKER_AUTH_DIAGNOSTICS/i.test(caller), "caller logs no token digest");
  for (const path of ["workers/accounting_worker/main.py", "workers/accounting_worker/auth.py"]) {
    const src = read(path);
    assert.ok(!/auth_compare|configured_sha256|received_sha256|WORKER_AUTH_DIAGNOSTICS/.test(src), `${path} logs no token digest`);
  }
});

test("a missing token is a named configuration error", () => {
  const error = new WorkerTokenMissingError();
  assert.equal(error.name, "WorkerTokenMissingError");
  assert.match(error.message, /ACCOUNTING_WORKER_TOKEN is not set/);
  assert.match(error.message, /not attempted/);
});

test("the route refuses to call the worker unauthenticated", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");

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

// The conversion worker's shared secret is compared in constant time, and
// /api/ocr-text is no longer open to everyone outside worker mode.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const { workerSecretMatches, requestCarriesWorkerSecret, WORKER_SECRET_HEADER } = await import("../../lib/worker-secret.ts");

test("matches only the exact secret", () => {
  assert.equal(workerSecretMatches("s3cret-value", "s3cret-value"), true);
  assert.equal(workerSecretMatches("s3cret-valuf", "s3cret-value"), false);
  assert.equal(workerSecretMatches("s3cret", "s3cret-value"), false, "a prefix is not a match");
  assert.equal(workerSecretMatches("s3cret-value-and-more", "s3cret-value"), false);
});

test("trims both sides, as the comparisons it replaced did", () => {
  assert.equal(workerSecretMatches("  s3cret-value\n", "s3cret-value "), true);
});

test("an unconfigured or empty secret never matches, even an empty guess", () => {
  for (const configured of [undefined, null, "", "   "]) {
    for (const provided of [undefined, null, "", "   ", "anything"]) {
      assert.equal(workerSecretMatches(provided, configured), false, `${JSON.stringify(provided)} vs ${JSON.stringify(configured)}`);
    }
  }
});

test("unequal lengths and non-ASCII input return false rather than throwing", () => {
  // timingSafeEqual throws on unequal lengths; hashing first makes that impossible.
  assert.doesNotThrow(() => workerSecretMatches("a", "a-much-longer-secret"));
  assert.equal(workerSecretMatches("s3cret-value​", "s3cret-value"), false);
  assert.equal(workerSecretMatches("sécret", "sécret"), true);
});

test("reads the header and CONVERSION_WORKER_SECRET", () => {
  const saved = process.env.CONVERSION_WORKER_SECRET;
  process.env.CONVERSION_WORKER_SECRET = "header-secret";
  try {
    const ok = new Request("http://x/", { headers: { [WORKER_SECRET_HEADER]: "header-secret" } });
    const wrong = new Request("http://x/", { headers: { [WORKER_SECRET_HEADER]: "nope" } });
    const none = new Request("http://x/");
    assert.equal(requestCarriesWorkerSecret(ok), true);
    assert.equal(requestCarriesWorkerSecret(wrong), false);
    assert.equal(requestCarriesWorkerSecret(none), false);
  } finally {
    if (saved === undefined) delete process.env.CONVERSION_WORKER_SECRET;
    else process.env.CONVERSION_WORKER_SECRET = saved;
  }
});

test("no worker route compares the secret with === any more", () => {
  for (const file of ["app/api/jobs/process/route.ts", "app/api/ocr-text/route.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /providedSecret\s*!==\s*configuredSecret|provided\s*===\s*configured/, file);
  }
  assert.match(read("app/api/jobs/process/route.ts"), /workerSecretMatches\(providedSecret, configuredSecret\)/);
});

test("/api/ocr-text requires the secret whenever one is configured, in any mode", () => {
  const route = read("app/api/ocr-text/route.ts");
  const fn = route.slice(route.indexOf("function authorized("), route.indexOf("// GET"));
  assert.match(fn, /if \(process\.env\.CONVERSION_WORKER_SECRET\?\.trim\(\)\) return requestCarriesWorkerSecret\(request\);/);
  assert.match(fn, /if \(process\.env\.CONVERSION_WORKER_MODE === "true"\) return false;/);
  assert.match(fn, /return !isSupabaseConfigured;/, "open only for a local dev server with no real backend");
  assert.doesNotMatch(fn, /!== "true"\) return true/, "the old 'outside worker mode, allow everyone' rule is gone");
});

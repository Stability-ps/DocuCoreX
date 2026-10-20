// F-34: /api/jobs/process authenticates before it validates the body, so an
// anonymous caller cannot use 400 responses to learn the request shape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../app/api/jobs/process/route.ts", import.meta.url), "utf8");
const post = source.slice(source.indexOf("export async function POST("), source.indexOf("export async function GET("));

test("the session check comes before body validation", () => {
  const auth = post.indexOf('code: "UNAUTHENTICATED"');
  const validation = post.indexOf("validateProcessRequest(");
  assert.ok(auth > 0 && validation > 0, "both checks are present in POST");
  assert.ok(auth < validation, "401 for anonymous callers is decided before any 400");
});

test("the worker secret is checked before body validation", () => {
  const secret = post.indexOf("workerSecretMatches(providedSecret, configuredSecret)");
  const validation = post.indexOf("validateProcessRequest(");
  assert.ok(secret > 0 && secret < validation);
});

test("the workspace ownership check still runs, after validation", () => {
  const validation = post.indexOf("validateProcessRequest(");
  const ownership = post.indexOf("requestTargetsWorkspace(caller, processRequest)");
  const proxy = post.indexOf("proxyToConversionWorker(request, processRequest)");
  assert.ok(validation < ownership && ownership < proxy, "ownership is enforced before anything is proxied");
});

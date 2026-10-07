import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { withUnauthorized, errorResponse, isUnauthorizedError } = await import("@/lib/api-auth.ts");

// A signed-out or expired session made getWorkspaceContext() throw
// Error("Unauthorized"), and these routes let it escape or caught it into a
// blanket 500 (release audit, 2026-10-07: e.g. GET /api/documents → 500
// "Unauthorized", GET /api/search → 500 with an empty body). The client could
// not tell "sign in again" from "the server broke".

test("withUnauthorized turns a thrown missing-session error into a 401", async () => {
  const handler = withUnauthorized(async () => {
    throw new Error("Unauthorized");
  });
  const response = await handler();
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /sign in/i);
});

test("withUnauthorized lets every other failure propagate unchanged", async () => {
  const handler = withUnauthorized(async () => {
    throw new Error("Supabase is not configured");
  });
  await assert.rejects(handler(), /Supabase is not configured/);
});

test("withUnauthorized passes through a successful response and its arguments", async () => {
  const handler = withUnauthorized(async (value: number) => new Response(String(value * 2), { status: 201 }));
  const response = await handler(21);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "42");
});

test("errorResponse maps only the missing session to 401", async () => {
  assert.equal(errorResponse(new Error("Unauthorized"), "x").status, 401);
  const failure = errorResponse(new Error("relation does not exist"), "Unable to load");
  assert.equal(failure.status, 500);
  assert.equal((await failure.json()).error, "relation does not exist");
  assert.equal(errorResponse("not an error", "Unable to load", 400).status, 400);
  assert.equal(isUnauthorizedError(new Error("Unauthorized!")), false, "exact message only");
});

// Wiring: each route that reported a missing session as a 500 must now go
// through one of the helpers. Bare getWorkspaceContext() is allowed only inside
// a handler that withUnauthorized wraps.
const routes = [
  "app/api/documents/route.ts",
  "app/api/invoices/route.ts",
  "app/api/companies/route.ts",
  "app/api/history/[documentId]/route.ts",
  "app/api/documents/bulk/route.ts",
  "app/api/search/route.ts",
  "app/api/comments/[documentId]/route.ts",
  "app/api/downloads/[documentId]/route.ts",
  "app/api/ai/[documentId]/route.ts",
  "app/api/conversions/route.ts",
  "app/api/uploads/workflow/route.ts",
  "app/api/uploads/download-all/route.ts",
  "app/api/accounting/ai/route.ts",
  "app/api/accounting/fnb/runs/[id]/cancel/route.ts",
  "app/api/ocr/[documentId]/route.ts",
  "app/api/documents/[id]/download/route.ts",
  "app/api/documents/[id]/preview/route.ts",
  "app/api/extractions/[documentId]/route.ts",
];

for (const route of routes) {
  test(`${route} answers a missing session with 401, not 500`, () => {
    const source = readFileSync(route, "utf8");
    const wrapped = /export const (GET|POST|PATCH|DELETE) = withUnauthorized\(/.test(source);
    const resolved = /resolveWorkspaceContext\(\)/.test(source) && !/await getWorkspaceContext\(\)/.test(source);
    const caught = /return errorResponse\(error,/.test(source) && !/status: 500 \}\);\s*\n\s*\}\s*\n\}/.test(source);
    assert.ok(wrapped || resolved || caught, `${route} must use withUnauthorized, resolveWorkspaceContext or errorResponse`);
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

// /debug/auth was a public prefix, so production served its diagnostics page —
// auth-required flag, demo mode, cookie names — to anonymous visitors (release
// audit, 2026-10-07). It is now protected like any app page.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // configured, unreachable
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

const { middleware } = await import("@/middleware.ts");
const { NextRequest } = await import("next/server");

test("an anonymous request for /debug/auth is sent to sign in", async () => {
  const response = await middleware(new NextRequest("https://www.docucorex.com/debug/auth"));
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/debug/auth");
});

test("public pages stay public", async () => {
  for (const path of ["/", "/login", "/signup"]) {
    const response = await middleware(new NextRequest(`https://www.docucorex.com${path}`));
    assert.equal(response.headers.get("location"), null, `${path} must not redirect`);
  }
});

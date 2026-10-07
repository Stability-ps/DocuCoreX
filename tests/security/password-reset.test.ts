import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

// Release audit, 2026-10-07: "Forgot password" emailed a link to /auth/callback,
// which signed the user in and went to the dashboard — nothing ever called
// updateUser({ password }), so the password never changed. The Settings link
// pointed at /login, which ignores the recovery code entirely.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // configured, unreachable
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

const { GET } = await import("@/app/auth/callback/route.ts");
const { NextRequest } = await import("next/server");

const call = async (query: string) => {
  const response = await GET(new NextRequest(`https://www.docucorex.com/auth/callback${query}`));
  return new URL(response.headers.get("location") ?? "", "https://www.docucorex.com");
};

test("a recovery link without a code lands on the reset page as invalid", async () => {
  const location = await call("?next=%2Fauth%2Freset-password");
  assert.equal(location.pathname, "/auth/reset-password");
  assert.equal(location.searchParams.get("error"), "link_invalid");
});

test("a recovery code that cannot be exchanged lands on the reset page as invalid", async () => {
  const location = await call("?code=expired-or-used&next=%2Fauth%2Freset-password");
  assert.equal(location.pathname, "/auth/reset-password");
  assert.equal(location.searchParams.get("error"), "link_invalid");
});

test("an ordinary sign-in callback failure still goes to /login", async () => {
  const location = await call("?code=bad&next=%2Fdashboard");
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("error"), "exchange_failed");
});

test("both forgot-password entry points send the link to the reset page", () => {
  for (const file of ["app/login/page.tsx", "components/settings-console.tsx"]) {
    const source = readFileSync(file, "utf8");
    const call = source.slice(source.indexOf("resetPasswordForEmail("));
    assert.match(call.slice(0, 300), /\/auth\/callback\?next=\$\{encodeURIComponent\("\/auth\/reset-password"\)\}/, file);
  }
});

test("the reset page actually sets the password", () => {
  const page = readFileSync("app/auth/reset-password/page.tsx", "utf8");
  assert.match(page, /supabase\.auth\.updateUser\(\{ password \}\)/);
});

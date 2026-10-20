// Sign-up must not reveal whether an address is registered (2026-10-20).
//
// With Supabase email confirmation off, a new address used to get a session,
// auth cookies and "Account created." while an existing one got "check your
// inbox". These tests drive lib/auth-signup.ts with a fake Supabase client for
// every answer Supabase gives, in both confirmation modes, and require one
// status, one body, no cookies and the same minimum duration. No real account
// is created anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { handleSignUp, SIGN_UP_MIN_RESPONSE_MS } = await import("@/lib/auth-signup.ts");
const { SIGN_UP_ACCEPTED_MESSAGE } = await import("@/lib/auth-errors.ts");

type Result = { data: { user: { id?: string; identities?: unknown[] | null } | null; session: unknown | null } | null; error: { status?: number; code?: string; message?: string } | null };

const BODY = { email: "person@example.com", password: "correct horse battery staple", fullName: "  Pat   Example " };

// What Supabase answers, per scenario.
const SCENARIOS: Record<string, Result> = {
  "new address, confirmation off": { data: { user: { id: "u1", identities: [{ id: "i1" }] }, session: { access_token: "at", refresh_token: "rt" } }, error: null },
  "existing address, confirmation off": { data: { user: null, session: null }, error: { status: 422, code: "user_already_exists", message: "User already registered" } },
  "existing address, older GoTrue": { data: { user: null, session: null }, error: { status: 422, message: "User already registered" } },
  "new address, confirmation on": { data: { user: { id: "u2", identities: [{ id: "i2" }] }, session: null }, error: null },
  "existing address, confirmation on (obfuscated user)": { data: { user: { id: "fake", identities: [] }, session: null }, error: null },
  "email send limit (only addresses that get an email)": { data: { user: null, session: null }, error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } },
};

function fakeClient(result: Result) {
  const calls = { signUp: [] as unknown[], signOut: 0 };
  return {
    calls,
    client: {
      auth: {
        async signUp(credentials: unknown) {
          calls.signUp.push(credentials);
          return result;
        },
        async signOut() {
          calls.signOut += 1;
          return { error: null };
        },
      },
    },
  };
}

// A fake clock: Supabase "takes" `supabaseMs`, sleeps advance the clock.
function fakeTime(supabaseMs: number) {
  let clock = 1_000;
  const slept: number[] = [];
  return {
    slept,
    elapsed: () => clock - 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    advance: () => {
      clock += supabaseMs;
    },
  };
}

async function run(result: Result, supabaseMs = 0, body: unknown = BODY) {
  const fake = fakeClient(result);
  const time = fakeTime(supabaseMs);
  const signUp = fake.client.auth.signUp.bind(fake.client.auth);
  fake.client.auth.signUp = async (credentials: unknown) => {
    time.advance();
    return signUp(credentials);
  };
  const quiet = { info: console.info, warn: console.warn };
  console.info = () => {};
  console.warn = () => {};
  try {
    const response = await handleSignUp(body, { client: fake.client, origin: "https://www.docucorex.com", now: time.now, sleep: time.sleep });
    return { response, json: await response.clone().json(), calls: fake.calls, elapsed: time.elapsed() };
  } finally {
    Object.assign(console, quiet);
  }
}

test("every accepted sign-up gets the same status, body and no cookies", async () => {
  const outcomes = [];
  for (const [name, result] of Object.entries(SCENARIOS)) {
    const { response, json } = await run(result);
    outcomes.push({ name, status: response.status, json, cookies: response.headers.getSetCookie() });
  }
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 200, outcome.name);
    assert.deepEqual(outcome.json, { success: true, message: SIGN_UP_ACCEPTED_MESSAGE }, outcome.name);
    assert.deepEqual(outcome.cookies, [], `${outcome.name} must not set cookies`);
  }
});

test("a session Supabase opens for a new account is revoked, never handed out", async () => {
  const { calls, json } = await run(SCENARIOS["new address, confirmation off"]);
  assert.equal(calls.signOut, 1);
  assert.equal(JSON.stringify(json).includes("rt"), false);
  for (const name of ["existing address, confirmation off", "new address, confirmation on", "existing address, confirmation on (obfuscated user)"]) {
    assert.equal((await run(SCENARIOS[name])).calls.signOut, 0, name);
  }
});

test("a failed session revoke still gets the neutral answer", async () => {
  const fake = fakeClient(SCENARIOS["new address, confirmation off"]);
  fake.client.auth.signOut = async () => {
    throw new Error("network down");
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const response = await handleSignUp(BODY, { client: fake.client, origin: "https://x", minResponseMs: 0 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, message: SIGN_UP_ACCEPTED_MESSAGE });
  } finally {
    console.warn = warn;
  }
});

test("every outcome takes at least the minimum response time, however fast Supabase answers", async () => {
  for (const [name, result] of Object.entries(SCENARIOS)) {
    for (const supabaseMs of [5, 400, 1200]) {
      const { elapsed } = await run(result, supabaseMs);
      assert.equal(elapsed, SIGN_UP_MIN_RESPONSE_MS, `${name} at ${supabaseMs} ms`);
    }
  }
  // Refusals are padded too, so a slow refusal is not told apart from a fast accept.
  const weak = await run({ data: null, error: { status: 422, code: "weak_password", message: "Password should be at least 8 characters." } }, 50);
  assert.equal(weak.elapsed, SIGN_UP_MIN_RESPONSE_MS);
  assert.equal(weak.response.status, 400);
});

test("the minimum covers a realistic Supabase user creation", () => {
  assert.ok(SIGN_UP_MIN_RESPONSE_MS >= 1000, "pad well above GoTrue's user creation time");
  assert.ok(SIGN_UP_MIN_RESPONSE_MS <= 3000, "but keep the form responsive");
});

test("validation verdicts that do not depend on the address keep their wording", async () => {
  const weak = await run({ data: null, error: { status: 422, code: "weak_password", message: "Password should be at least 8 characters." } });
  assert.equal(weak.response.status, 400);
  assert.equal(weak.json.error, "Password should be at least 8 characters.");
  const invalid = await run({ data: null, error: { status: 400, code: "email_address_invalid", message: "Email address \"x\" is invalid" } });
  assert.equal(invalid.json.error, "Enter a valid email address.");
  const unexpected = await run({ data: null, error: { status: 500, code: "unexpected_failure", message: "Database error saving new user" } });
  assert.doesNotMatch(unexpected.json.error, /database/i);
});

test("missing fields are refused before Supabase is called", async () => {
  for (const body of [null, {}, { ...BODY, email: "" }, { ...BODY, password: "" }, { ...BODY, fullName: "  " }, { ...BODY, email: ["a@b.c"] }]) {
    const { response, calls } = await run(SCENARIOS["new address, confirmation off"], 0, body);
    assert.equal(response.status, 400);
    assert.equal(calls.signUp.length, 0);
  }
  const short = await run(SCENARIOS["new address, confirmation off"], 0, { ...BODY, fullName: "P" });
  assert.equal(short.response.status, 400);
});

test("the verification link and the profile name are passed to Supabase", async () => {
  const { calls } = await run(SCENARIOS["new address, confirmation on"]);
  assert.deepEqual(calls.signUp[0], {
    email: BODY.email,
    password: BODY.password,
    options: {
      emailRedirectTo: "https://www.docucorex.com/auth/callback",
      data: { product: "DocuCoreX", full_name: "Pat Example", name: "Pat Example" },
    },
  });
});

test("the route drops Supabase's cookies and keeps the IP-keyed limit first", () => {
  const route = readFileSync("app/api/auth/signup/route.ts", "utf8");
  assert.match(route, /setAll\(\) \{\}/);
  assert.doesNotMatch(route, /setSupabaseAuthCookie|ensureUserWorkspace/);
  assert.ok(route.indexOf('enforceRateLimit("signup", { request }') < route.indexOf("handleSignUp("), "limit before any address-dependent work");
});

test("the sign-up form moves to sign-in instead of expecting a session", () => {
  const page = readFileSync("app/login/page.tsx", "utf8");
  const signup = page.slice(page.indexOf('fetch("/api/auth/signup"'), page.indexOf('if (mode === "forgot")'));
  assert.match(signup, /setMode\("signin"\)/);
  assert.match(signup, /SIGN_UP_ACCEPTED_MESSAGE/);
  assert.doesNotMatch(signup, /requiresEmailVerification|window\.location\.href = nextPath/);
});

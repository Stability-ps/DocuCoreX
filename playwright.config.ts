import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  // One retry on CI only, now that this suite gates merges (#64): a genuine
  // failure still fails twice and blocks, while a one-off timing flake in a
  // browser test does not stop everyone else from merging. Kept at 0 locally so
  // a flake is visible while you are working on it rather than silently passing
  // on the second attempt.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec next dev -p 3100",
    url: "http://127.0.0.1:3100",
    // The suite must see the same app CI sees, and NEXT_PUBLIC_REQUIRE_AUTH=false
    // alone did not achieve that. middleware.ts requires auth whenever a real
    // Supabase backend is configured, regardless of that flag — deliberately, so
    // a real backend never serves protected pages unauthenticated. A developer
    // with credentials in .env.local therefore got /login for every protected
    // route and could not exercise the app shell at all, while CI, which has no
    // .env.local, ran unauthenticated and green.
    //
    // Blanking the Supabase variables for the test server puts it in the same
    // no-backend mode as CI. Next.js does not overwrite variables already
    // present in the environment, so these win over .env.local. The middleware
    // rule itself is untouched.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_REQUIRE_AUTH: "false",
    },
    // Not reused: a server left on 3100 from an earlier run is configured
    // however that run left it, and reusing it silently tests something other
    // than what this config describes. Costs a few seconds of startup; buys the
    // guarantee that a local run and a CI run mean the same thing. 3100 is
    // test-only, so this does not disturb `pnpm dev` on 3000.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
    {
      // A short 13"-laptop-height viewport, e.g. with browser chrome eating into
      // available height. Regression coverage for sidebar content getting
      // clipped rather than scrolling when there isn't enough vertical room.
      name: "laptop-short",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 700 } },
    },
  ],
});

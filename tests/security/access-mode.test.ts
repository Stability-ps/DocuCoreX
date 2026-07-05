import test from "node:test";
import assert from "node:assert/strict";
import { computeAccessFlags } from "../../lib/access-mode.ts";

// P0 data-isolation invariant: when a real Supabase backend is configured,
// demo/mock data must be UNREACHABLE and auth must be REQUIRED, no matter how
// the other environment flags are (mis)configured.
test("demo is impossible and auth is required whenever Supabase is configured", () => {
  const nodeEnvs = ["production", "development", "test", undefined];
  const requireAuths = ["true", "false", "", undefined];
  const enableDemos = ["true", "false", "", undefined];

  for (const nodeEnv of nodeEnvs) {
    for (const requireAuth of requireAuths) {
      for (const enableDemo of enableDemos) {
        const flags = computeAccessFlags({ supabaseConfigured: true, nodeEnv, requireAuth, enableDemo });
        assert.equal(
          flags.isDemoAllowed,
          false,
          `isDemoAllowed must be false when Supabase is configured (nodeEnv=${nodeEnv}, requireAuth=${requireAuth}, enableDemo=${enableDemo})`,
        );
        assert.equal(
          flags.isAuthRequired,
          true,
          `isAuthRequired must be true when Supabase is configured (nodeEnv=${nodeEnv}, requireAuth=${requireAuth}, enableDemo=${enableDemo})`,
        );
      }
    }
  }
});

test("production requires auth by default even without Supabase", () => {
  const flags = computeAccessFlags({ supabaseConfigured: false, nodeEnv: "production" });
  assert.equal(flags.isAuthRequired, true);
  assert.equal(flags.isDemoAllowed, false, "demo must never be on in production");
});

test("demo mode only exists in local dev with no backend and the flag enabled", () => {
  // Enabled: no supabase + dev + explicit flag.
  assert.equal(
    computeAccessFlags({ supabaseConfigured: false, nodeEnv: "development", enableDemo: "true" }).isDemoAllowed,
    true,
  );
  // Flag off → no demo.
  assert.equal(
    computeAccessFlags({ supabaseConfigured: false, nodeEnv: "development", enableDemo: undefined }).isDemoAllowed,
    false,
  );
  // Backend present → flag is ignored, no demo.
  assert.equal(
    computeAccessFlags({ supabaseConfigured: true, nodeEnv: "development", enableDemo: "true" }).isDemoAllowed,
    false,
  );
});

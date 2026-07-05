import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relativePath: string) => readFileSync(join(root, relativePath), "utf8");

// These are static regression guards: they assert the P0 data-isolation fixes
// remain in place so the shared-data leak cannot silently return.

// 1. The four previously-unauthenticated settings routes must now require a
//    workspace/user context and return 401 when there is none — and must NOT
//    reference the old shared global `appStore` singleton.
const settingsRoutes = [
  "app/api/team/route.ts",
  "app/api/user-settings/route.ts",
  "app/api/integrations/route.ts",
  "app/api/automations/route.ts",
];

for (const route of settingsRoutes) {
  test(`${route} requires an authenticated workspace and cannot use a shared store`, () => {
    const source = read(route);
    assert.match(source, /getSettingsAccess\s*\(/, `${route} must resolve workspace-scoped access`);
    assert.match(source, /status:\s*401/, `${route} must return 401 when unauthenticated`);
    assert.doesNotMatch(source, /\bappStore\b/, `${route} must not reference the removed shared appStore singleton`);
  });
}

// 2. The shared in-memory app store singleton must be gone entirely.
test("lib/app-state.ts no longer exports a shared appStore singleton", () => {
  const source = read("lib/app-state.ts");
  assert.doesNotMatch(source, /export\s+const\s+appStore/, "the shared appStore export must be removed");
  assert.doesNotMatch(source, /patric@docucorex/i, "no hardcoded person seed data may remain");
});

// 3. The mock repository must only seed demo data when there is NO Supabase
//    backend configured, so a real deployment can never serve seeded data.
test("lib/mock-repository.ts gates its seed on the absence of Supabase", () => {
  const source = read("lib/mock-repository.ts");
  assert.match(source, /!isSupabaseConfigured/, "the demo seed must be gated on !isSupabaseConfigured");
});

// 4. Routes that previously relied only on RLS now filter explicitly by
//    workspace_id (defense-in-depth).
const workspaceFilteredRoutes = [
  "app/api/usage/route.ts",
  "app/api/audit-logs/route.ts",
  "app/api/api-keys/route.ts",
  "app/api/jobs/route.ts",
];
for (const route of workspaceFilteredRoutes) {
  test(`${route} filters by workspace_id explicitly`, () => {
    const source = read(route);
    assert.match(source, /workspace_id/, `${route} must reference workspace_id filtering`);
  });
}

// 5. Sign-out and login must clear cached per-user client data.
test("sign-out and login clear cached client data", () => {
  const shell = read("components/app-shell.tsx");
  assert.match(shell, /clearDocucorexClientCache\s*\(\s*\)/, "app-shell signOut must clear the client cache");
  const login = read("app/login/page.tsx");
  assert.match(login, /clearDocucorexClientCache\s*\(\s*\)/, "login screen must clear the client cache");
});

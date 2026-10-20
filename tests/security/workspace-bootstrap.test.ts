// Signing in must not make anyone an Owner of a workspace they do not own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("signing in records Owner only for the workspace's real owner", () => {
  const bootstrap = read("lib/workspace-bootstrap.ts");
  const existing = bootstrap.slice(bootstrap.indexOf("if (existingProfile?.workspace_id) {"), bootstrap.indexOf("const company ="));
  const ownerCheck = existing.indexOf("if (workspace?.owner_id === user.id) {");
  const upsert = existing.indexOf('ensureTeamMember(existingProfile.workspace_id, user.id, user.email, "Owner")');
  assert.ok(ownerCheck > 0 && upsert > ownerCheck, "the Owner row is written only inside the owner check");
});

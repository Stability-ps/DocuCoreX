// Team membership is managed by the owner and Admins only (migration 054 plus the API).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const { decideTeamChange, asTeamRole } = await import("../../lib/team-permissions.ts");

const ok = (d: { allowed: boolean }) => assert.equal(d.allowed, true);
const no = (d: { allowed: boolean }) => assert.equal(d.allowed, false);

test("ordinary members cannot change the team at all", () => {
  for (const role of ["Finance", "Auditor", "Viewer", null] as const) {
    no(decideTeamChange(role, { kind: "invite", newRole: "Viewer" }));
    no(decideTeamChange(role, { kind: "change_role", targetRole: role ?? "Viewer", newRole: "Owner", targetIsSelf: true }));
    no(decideTeamChange(role, { kind: "change_role", targetRole: "Viewer", newRole: "Admin", targetIsSelf: false }));
    no(decideTeamChange(role, { kind: "remove", targetRole: "Admin", targetIsSelf: false }));
    no(decideTeamChange(role, { kind: "remove", targetRole: "Owner", targetIsSelf: false }));
  }
});

test("an Admin manages ordinary members", () => {
  ok(decideTeamChange("Admin", { kind: "invite", newRole: "Viewer" }));
  ok(decideTeamChange("Admin", { kind: "invite", newRole: "Admin" }));
  ok(decideTeamChange("Admin", { kind: "change_role", targetRole: "Viewer", newRole: "Finance", targetIsSelf: false }));
  ok(decideTeamChange("Admin", { kind: "remove", targetRole: "Auditor", targetIsSelf: false }));
});

test("an Admin cannot create, touch or become an Owner, nor change themselves", () => {
  no(decideTeamChange("Admin", { kind: "invite", newRole: "Owner" }));
  no(decideTeamChange("Admin", { kind: "change_role", targetRole: "Viewer", newRole: "Owner", targetIsSelf: false }));
  no(decideTeamChange("Admin", { kind: "change_role", targetRole: "Owner", newRole: "Viewer", targetIsSelf: false }));
  no(decideTeamChange("Admin", { kind: "remove", targetRole: "Owner", targetIsSelf: false }));
  no(decideTeamChange("Admin", { kind: "change_role", targetRole: "Admin", newRole: "Owner", targetIsSelf: true }));
  no(decideTeamChange("Admin", { kind: "remove", targetRole: "Admin", targetIsSelf: true }));
});

test("the owner can do anything", () => {
  ok(decideTeamChange("Owner", { kind: "invite", newRole: "Owner" }));
  ok(decideTeamChange("Owner", { kind: "change_role", targetRole: "Admin", newRole: "Owner", targetIsSelf: false }));
  ok(decideTeamChange("Owner", { kind: "remove", targetRole: "Admin", targetIsSelf: false }));
});

test("unknown role strings are not roles", () => {
  assert.equal(asTeamRole("Owner"), "Owner");
  assert.equal(asTeamRole("owner"), null);
  assert.equal(asTeamRole("Superuser"), null);
  assert.equal(asTeamRole(undefined), null);
});

test("every team mutation is checked before it runs", () => {
  const route = read("app/api/team/route.ts");
  for (const [check, mutation] of [
    ['refuse(access, { kind: "invite"', "inviteTeamMember(access, email, role)"],
    ['refuse(access, {\n    kind: "change_role"', "updateTeamMemberRole(access, body.id"],
    ['refuse(access, { kind: "remove"', "removeTeamMember(access, body.id)"],
  ]) {
    const c = route.indexOf(check);
    const m = route.indexOf(mutation);
    assert.ok(c > 0 && m > c, `${mutation} must be preceded by its permission check`);
  }
  assert.match(route, /status: 403/);
});

test("the caller's role comes from the same database function as the policies", () => {
  assert.match(read("lib/app-state.ts"), /rpc\("workspace_team_role", \{ p_workspace_id: access\.workspaceId \}\)/);
  assert.match(read("supabase/migrations/054_team_role_enforcement.sql"), /create or replace function public\.workspace_team_role\(p_workspace_id uuid\)/);
});

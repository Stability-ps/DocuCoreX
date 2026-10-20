// Who may change a workspace's team. The same rules as migration 054's RLS
// policies, checked in the API first so a refused request gets a clear 403
// rather than a silent "0 rows changed" from the database.
//
//   Owner (workspaces.owner_id): anything.
//   Admin: members who are not, and will not become, Owner — never their own row.
//   Finance / Auditor / Viewer: read only.

export type TeamRole = "Owner" | "Admin" | "Finance" | "Auditor" | "Viewer";

export type TeamChange =
  | { kind: "invite"; newRole: TeamRole }
  | { kind: "change_role"; targetRole: TeamRole; newRole: TeamRole; targetIsSelf: boolean }
  | { kind: "remove"; targetRole: TeamRole; targetIsSelf: boolean };

export type TeamDecision = { allowed: true } | { allowed: false; reason: string };

const DENY_READ_ONLY: TeamDecision = { allowed: false, reason: "Only the workspace owner or an Admin can manage the team." };

export function decideTeamChange(callerRole: TeamRole | null, change: TeamChange): TeamDecision {
  if (callerRole === "Owner") return { allowed: true };
  if (callerRole !== "Admin") return DENY_READ_ONLY;

  if (change.kind === "invite") {
    return change.newRole === "Owner" ? { allowed: false, reason: "Only the workspace owner can add an Owner." } : { allowed: true };
  }
  if (change.targetIsSelf) return { allowed: false, reason: "Admins cannot change their own membership." };
  if (change.targetRole === "Owner") return { allowed: false, reason: "Only the workspace owner can change an Owner." };
  if (change.kind === "change_role" && change.newRole === "Owner") {
    return { allowed: false, reason: "Only the workspace owner can make someone an Owner." };
  }
  return { allowed: true };
}

const ROLES: ReadonlySet<string> = new Set(["Owner", "Admin", "Finance", "Auditor", "Viewer"]);

export function asTeamRole(value: unknown): TeamRole | null {
  return typeof value === "string" && ROLES.has(value) ? (value as TeamRole) : null;
}

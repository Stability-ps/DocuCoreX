import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import {
  getCallerTeamRole,
  getTeamMemberSubject,
  getSettingsAccess,
  getTeamMembers,
  inviteTeamMember,
  updateTeamMemberRole,
  removeTeamMember,
  type TeamMemberRecord,
} from "@/lib/app-state";
import { createNotification } from "@/lib/notifications";
import { decideTeamChange, type TeamChange } from "@/lib/team-permissions";

const roles = ["Owner", "Admin", "Finance", "Auditor", "Viewer"] as const;

export async function GET() {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const members = await getTeamMembers(access);
  return NextResponse.json({ members });
}

export async function POST(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { email?: string; role?: TeamMemberRecord["role"] };
  const email = body.email?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  const role = roles.includes(body.role as TeamMemberRecord["role"]) ? (body.role as TeamMemberRecord["role"]) : "Viewer";
  const denied = await refuse(access, { kind: "invite", newRole: role });
  if (denied) return denied;
  const member = await inviteTeamMember(access, email, role);

  await createNotification({
    type: "team_user_invited",
    title: "Team invite created",
    body: `${email} was invited as ${role}.`,
    entityType: "invite",
    entityId: member.id,
    href: "/settings",
  });

  await recordAuditLog({
    action: "team_invite_created",
    entityType: "invite",
    entityId: member.id,
    metadata: { email, role },
  });

  return NextResponse.json({ member });
}

export async function PATCH(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { id?: string; role?: TeamMemberRecord["role"] };
  if (!body.id) return NextResponse.json({ error: "Member id is required" }, { status: 400 });
  if (!roles.includes(body.role as TeamMemberRecord["role"])) {
    return NextResponse.json({ error: "Valid role is required" }, { status: 400 });
  }

  const target = await getTeamMemberSubject(access, body.id);
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const denied = await refuse(access, {
    kind: "change_role",
    targetRole: target.role,
    newRole: body.role as TeamMemberRecord["role"],
    targetIsSelf: isSelf(access, target.userId),
  });
  if (denied) return denied;

  const result = await updateTeamMemberRole(access, body.id, body.role as TeamMemberRecord["role"]);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await recordAuditLog({
    action: "team_role_updated",
    entityType: "team_member",
    entityId: body.id,
    metadata: { role: body.role },
  });

  return NextResponse.json({ member: result.member });
}

export async function DELETE(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "Member id is required" }, { status: 400 });

  const target = await getTeamMemberSubject(access, body.id);
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const denied = await refuse(access, { kind: "remove", targetRole: target.role, targetIsSelf: isSelf(access, target.userId) });
  if (denied) return denied;

  const result = await removeTeamMember(access, body.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await recordAuditLog({
    action: "team_member_removed",
    entityType: "team_member",
    entityId: body.id,
  });

  return NextResponse.json({ removed: true });
}

type Access = NonNullable<Awaited<ReturnType<typeof getSettingsAccess>>>;

function isSelf(access: Access, userId: string | null): boolean {
  return access.mode === "live" && userId !== null && userId === access.userId;
}

// Server-side role check (migration 054 enforces the same in the database).
async function refuse(access: Access, change: TeamChange): Promise<NextResponse | null> {
  const decision = decideTeamChange(await getCallerTeamRole(access), change);
  if (decision.allowed) return null;
  await recordAuditLog({ action: "team_change_refused", entityType: "team_member", metadata: { kind: change.kind } });
  return NextResponse.json({ error: decision.reason, code: "FORBIDDEN" }, { status: 403 });
}

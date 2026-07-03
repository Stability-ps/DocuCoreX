import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { appStore, type TeamMemberRecord } from "@/lib/app-state";
import { createNotification } from "@/lib/notifications";

const roles = ["Owner", "Admin", "Finance", "Auditor", "Viewer"] as const;

export async function GET() {
  return NextResponse.json({ members: appStore.teamMembers });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; role?: TeamMemberRecord["role"] };
  const email = body.email?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  const role = roles.includes(body.role as TeamMemberRecord["role"]) ? (body.role as TeamMemberRecord["role"]) : "Viewer";
  const member: TeamMemberRecord = {
    id: `invite_${Date.now()}`,
    name: email.split("@")[0],
    email,
    role,
    status: "Invited",
  };

  appStore.teamMembers.unshift(member);
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

import { NextResponse } from "next/server";
import { getSettingsAccess } from "@/lib/app-state";
import {
  clearAllNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
} from "@/lib/notifications";

// lib/notifications.ts falls back to the in-memory demo store whenever it cannot
// resolve a workspace, so a signed-out request on a real backend used to get
// 200 [] instead of an auth error. Resolve access here first, as the settings
// routes do: null means Supabase is configured and there is no session.
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  if (!(await getSettingsAccess())) return unauthorized();
  const notifications = await listNotifications();
  return NextResponse.json({ notifications });
}

export async function PATCH(request: Request) {
  if (!(await getSettingsAccess())) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { id?: string; ids?: string[]; allRead?: boolean };

  const notifications = body.allRead
    ? await markAllNotificationsRead()
    : Array.isArray(body.ids) && body.ids.length > 0
      ? await markNotificationsRead(body.ids)
      : body.id
        ? await markNotificationRead(body.id)
        : await listNotifications();

  return NextResponse.json({ notifications });
}

export async function DELETE(request: Request) {
  if (!(await getSettingsAccess())) return unauthorized();
  const body = (await request.json().catch(() => ({}))) as { id?: string; clearAll?: boolean };

  const notifications = body.clearAll
    ? await clearAllNotifications()
    : body.id
      ? await deleteNotification(body.id)
      : await listNotifications();

  return NextResponse.json({ notifications });
}

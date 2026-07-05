import { NextResponse } from "next/server";
import {
  clearAllNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationsRead,
} from "@/lib/notifications";

export async function GET() {
  const notifications = await listNotifications();
  return NextResponse.json({ notifications });
}

export async function PATCH(request: Request) {
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
  const body = (await request.json().catch(() => ({}))) as { id?: string; clearAll?: boolean };

  const notifications = body.clearAll
    ? await clearAllNotifications()
    : body.id
      ? await deleteNotification(body.id)
      : await listNotifications();

  return NextResponse.json({ notifications });
}

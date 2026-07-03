import { NextResponse } from "next/server";
import {
  clearAllNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications";

export async function GET() {
  const notifications = await listNotifications();
  return NextResponse.json({ notifications });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; allRead?: boolean };

  const notifications = body.allRead
    ? await markAllNotificationsRead()
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

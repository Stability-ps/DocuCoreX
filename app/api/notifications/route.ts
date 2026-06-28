import { NextResponse } from "next/server";
import { appStore } from "@/lib/app-state";

export async function GET() {
  return NextResponse.json({ notifications: appStore.notifications });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; read?: boolean; allRead?: boolean };

  if (body.allRead) {
    appStore.notifications.forEach((notification) => {
      notification.read = true;
    });
  } else if (body.id) {
    const notification = appStore.notifications.find((item) => item.id === body.id);
    if (notification) notification.read = body.read ?? true;
  }

  return NextResponse.json({ notifications: appStore.notifications });
}

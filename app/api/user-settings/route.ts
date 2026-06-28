import { NextResponse } from "next/server";
import { appStore, type UserSettingsRecord } from "@/lib/app-state";

export async function GET() {
  return NextResponse.json({ settings: appStore.userSettings });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Partial<UserSettingsRecord>;

  Object.assign(appStore.userSettings, body);

  return NextResponse.json({ settings: appStore.userSettings });
}

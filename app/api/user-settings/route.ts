import { NextResponse } from "next/server";
import { getSettingsAccess, getUserSettings, updateUserSettings, type UserSettingsRecord } from "@/lib/app-state";

export async function GET() {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await getUserSettings(access);
  return NextResponse.json({ settings });
}

export async function PATCH(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<UserSettingsRecord>;
  const settings = await updateUserSettings(access, body);
  return NextResponse.json({ settings });
}

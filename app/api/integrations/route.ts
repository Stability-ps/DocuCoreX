import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getSettingsAccess, getIntegrations, updateIntegration } from "@/lib/app-state";

export async function GET() {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const integrations = await getIntegrations(access);
  return NextResponse.json({ integrations });
}

export async function POST(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    status?: "ready_to_connect" | "connected" | "failed";
    config?: Record<string, string>;
  };

  if (!body.id) {
    return NextResponse.json({ error: "Integration id is required" }, { status: 400 });
  }

  const integration = await updateIntegration(access, body.id, body.status, body.config);

  if (!integration) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  if (integration.status === "connected") {
    await recordAuditLog({
      action: "integration_connected",
      entityType: "integration",
      entityId: integration.id,
      metadata: { name: integration.name },
    });
  }

  return NextResponse.json({ integration });
}

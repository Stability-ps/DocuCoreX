import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { appStore } from "@/lib/app-state";

export async function GET() {
  return NextResponse.json({ integrations: appStore.integrations });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; status?: "ready_to_connect" | "connected" | "failed"; config?: Record<string, string> };
  const integration = appStore.integrations.find((item) => item.id === body.id);

  if (!integration) {
    return NextResponse.json({ error: "Integration not found" }, { status: 404 });
  }

  integration.status = body.status ?? (integration.status === "connected" ? "ready_to_connect" : "connected");
  integration.config = body.config ?? integration.config;
  integration.updatedAt = new Date().toISOString();

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

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import {
  getSettingsAccess,
  getAutomationState,
  createAutomationPipeline,
  toggleAutomationPipeline,
  createSupportRequest,
} from "@/lib/app-state";

export async function GET() {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { pipelines, requests } = await getAutomationState(access);
  return NextResponse.json({ pipelines, requests });
}

export async function POST(request: Request) {
  const access = await getSettingsAccess();
  if (!access) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    type?: "pipeline" | "request" | "toggle";
    id?: string;
    name?: string;
    input?: string;
    output?: string;
    body?: string;
  };

  if (body.type === "request") {
    if (!body.body?.trim()) return NextResponse.json({ error: "Request body is required" }, { status: 400 });
    const created = await createSupportRequest(access, body.body.trim());
    await recordAuditLog({ action: "support_request_created", entityType: "support_request", entityId: created.id });
    return NextResponse.json({ request: created });
  }

  if (body.type === "toggle") {
    if (!body.id) return NextResponse.json({ error: "Pipeline id is required" }, { status: 400 });
    const pipeline = await toggleAutomationPipeline(access, body.id);
    if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    await recordAuditLog({
      action: "automation_toggled",
      entityType: "automation_pipeline",
      entityId: pipeline.id,
      metadata: { active: pipeline.active },
    });
    return NextResponse.json({ pipeline });
  }

  const pipeline = await createAutomationPipeline(access, {
    name: body.name?.trim() || "New automation pipeline",
    input: body.input?.trim() || "Manual uploads",
    output: body.output?.trim() || "Document library",
  });
  await recordAuditLog({ action: "automation_created", entityType: "automation_pipeline", entityId: pipeline.id });
  return NextResponse.json({ pipeline });
}

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { appStore, type AutomationPipelineRecord } from "@/lib/app-state";

export async function GET() {
  return NextResponse.json({
    pipelines: appStore.automationPipelines,
    requests: appStore.supportRequests,
  });
}

export async function POST(request: Request) {
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
    const request = { id: `request_${Date.now()}`, body: body.body.trim(), status: "open" as const, createdAt: new Date().toISOString() };
    appStore.supportRequests.unshift(request);
    await recordAuditLog({ action: "support_request_created", entityType: "support_request", entityId: request.id });
    return NextResponse.json({ request });
  }

  if (body.type === "toggle") {
    const pipeline = appStore.automationPipelines.find((item) => item.id === body.id);
    if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    pipeline.active = !pipeline.active;
    await recordAuditLog({
      action: "automation_toggled",
      entityType: "automation_pipeline",
      entityId: pipeline.id,
      metadata: { active: pipeline.active },
    });
    return NextResponse.json({ pipeline });
  }

  const pipeline: AutomationPipelineRecord = {
    id: `pipeline_${Date.now()}`,
    name: body.name?.trim() || "New automation pipeline",
    input: body.input?.trim() || "Manual uploads",
    output: body.output?.trim() || "Document library",
    active: true,
    createdAt: new Date().toISOString(),
  };

  appStore.automationPipelines.unshift(pipeline);
  await recordAuditLog({ action: "automation_created", entityType: "automation_pipeline", entityId: pipeline.id });
  return NextResponse.json({ pipeline });
}

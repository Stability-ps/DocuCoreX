import { auditLogs } from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function recordAuditLog(input: {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const createdAt = new Date().toISOString();
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    (auditLogs as Array<Record<string, unknown>>).unshift({
      id: `audit_${Date.now()}`,
      actor: "System",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? {},
      createdAt,
    });
    return;
  }

  await context.supabase.from("audit_logs").insert({
    workspace_id: context.workspaceId,
    actor_id: context.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId && uuidPattern.test(input.entityId) ? input.entityId : null,
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.entityId && !uuidPattern.test(input.entityId) ? { externalEntityId: input.entityId } : {}),
    },
  });
}

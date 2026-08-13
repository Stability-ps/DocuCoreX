/**
 * Audit trail data access: a filtered, paginated read over
 * accounting_audit_events. Nothing here writes to that table — every row is
 * produced by the triggers in migration 041, never by application code.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { AuditEvent } from "@/lib/accounting/audit-trail";

async function requireEntity(companyId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Entity not found in this workspace.");
  return context;
}

function mapEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    previousValue: row.previous_value ?? null,
    newValue: row.new_value ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    actorId: (row.actor_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export async function listAuditEvents(input: {
  companyId: string;
  action?: string | null;
  entityType?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ events: AuditEvent[]; total: number }> {
  const context = await requireEntity(input.companyId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);

  let query = context.supabase
    .from("accounting_audit_events")
    .select("*", { count: "exact" })
    .eq("company_id", input.companyId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (input.action) query = query.eq("action", input.action);
  if (input.entityType) query = query.eq("entity_type", input.entityType);
  if (input.fromDate) query = query.gte("created_at", input.fromDate);
  if (input.toDate) query = query.lte("created_at", input.toDate);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { events: (data ?? []).map(mapEvent), total: count ?? 0 };
}

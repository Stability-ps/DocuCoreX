import { getWorkspaceContext } from "@/lib/server-documents";
import { notifications as mockNotifications } from "@/lib/mock-repository";
import type { NotificationRecord, NotificationType } from "@/lib/types";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Duplicate notifications for the same event (same type + entity) within this
// window are suppressed so retries / re-renders don't spam the same alert.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

type NotificationRow = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  type: string | null;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  href: string | null;
  read_at: string | null;
  created_at: string;
};

function mapRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    type: (row.type as NotificationType) ?? "system_maintenance_notice",
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export type CreateNotificationInput = {
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  href?: string | null;
  userId?: string | null;
};

export async function listNotifications(): Promise<NotificationRecord[]> {
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    return [...mockNotifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  const { data, error } = await context.supabase
    .from("notifications")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .or(`user_id.is.null,user_id.eq.${context.userId}`)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !data) return [];

  return (data as NotificationRow[]).map(mapRow);
}

export async function createNotification(input: CreateNotificationInput): Promise<NotificationRecord | null> {
  const context = await getWorkspaceContext().catch(() => null);
  const dedupeAfter = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();

  if (!context) {
    const duplicate = mockNotifications.find(
      (item) =>
        item.type === input.type &&
        item.entityType === (input.entityType ?? null) &&
        item.entityId === (input.entityId ?? null) &&
        item.readAt === null &&
        item.createdAt >= dedupeAfter,
    );
    if (duplicate) return duplicate;

    const record: NotificationRecord = {
      id: `notification_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: "workspace_demo",
      userId: input.userId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      href: input.href ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    mockNotifications.unshift(record);
    return record;
  }

  const entityId = input.entityId && uuidPattern.test(input.entityId) ? input.entityId : null;

  let dedupeQuery = context.supabase
    .from("notifications")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("type", input.type)
    .is("read_at", null)
    .gte("created_at", dedupeAfter)
    .limit(1);

  dedupeQuery = entityId ? dedupeQuery.eq("entity_id", entityId) : dedupeQuery.is("entity_id", null);

  const { data: existing } = await dedupeQuery;
  if (existing && existing.length > 0) {
    return mapRow(existing[0] as NotificationRow);
  }

  const { data, error } = await context.supabase
    .from("notifications")
    .insert({
      workspace_id: context.workspaceId,
      user_id: input.userId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      entity_type: input.entityType ?? null,
      entity_id: entityId,
      href: input.href ?? null,
    })
    .select("*")
    .single();

  if (error || !data) return null;
  return mapRow(data as NotificationRow);
}

export async function markNotificationRead(id: string): Promise<NotificationRecord[]> {
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    const notification = mockNotifications.find((item) => item.id === id);
    if (notification && !notification.readAt) notification.readAt = new Date().toISOString();
    return listNotifications();
  }

  await context.supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", context.workspaceId)
    .is("read_at", null);

  return listNotifications();
}

export async function markNotificationsRead(ids: string[]): Promise<NotificationRecord[]> {
  if (!ids.length) return listNotifications();
  const context = await getWorkspaceContext().catch(() => null);
  const readAt = new Date().toISOString();

  if (!context) {
    ids.forEach((id) => {
      const notification = mockNotifications.find((item) => item.id === id);
      if (notification && !notification.readAt) notification.readAt = readAt;
    });
    return listNotifications();
  }

  await context.supabase
    .from("notifications")
    .update({ read_at: readAt })
    .eq("workspace_id", context.workspaceId)
    .in("id", ids)
    .is("read_at", null);

  return listNotifications();
}

export async function markAllNotificationsRead(): Promise<NotificationRecord[]> {
  const context = await getWorkspaceContext().catch(() => null);
  const readAt = new Date().toISOString();

  if (!context) {
    mockNotifications.forEach((notification) => {
      if (!notification.readAt) notification.readAt = readAt;
    });
    return listNotifications();
  }

  await context.supabase
    .from("notifications")
    .update({ read_at: readAt })
    .eq("workspace_id", context.workspaceId)
    .or(`user_id.is.null,user_id.eq.${context.userId}`)
    .is("read_at", null);

  return listNotifications();
}

export async function deleteNotification(id: string): Promise<NotificationRecord[]> {
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    const index = mockNotifications.findIndex((item) => item.id === id);
    if (index !== -1) mockNotifications.splice(index, 1);
    return listNotifications();
  }

  await context.supabase.from("notifications").delete().eq("id", id).eq("workspace_id", context.workspaceId);
  return listNotifications();
}

export async function clearAllNotifications(): Promise<NotificationRecord[]> {
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    mockNotifications.splice(0, mockNotifications.length);
    return listNotifications();
  }

  await context.supabase
    .from("notifications")
    .delete()
    .eq("workspace_id", context.workspaceId)
    .or(`user_id.is.null,user_id.eq.${context.userId}`);

  return listNotifications();
}

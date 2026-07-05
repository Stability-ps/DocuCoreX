import { isSupabaseConfigured } from "@/lib/supabase";
import { getWorkspaceContext } from "@/lib/server-documents";

export type TeamMemberRecord = {
  id: string;
  name: string;
  email: string;
  role: "Owner" | "Admin" | "Finance" | "Auditor" | "Viewer";
  status: "Active" | "Invited";
};

export type IntegrationRecord = {
  id: string;
  name: string;
  category: string;
  status: "ready_to_connect" | "connected" | "failed";
  config: Record<string, string>;
  updatedAt: string;
};

export type AutomationPipelineRecord = {
  id: string;
  name: string;
  input: string;
  output: string;
  active: boolean;
  createdAt: string;
};

export type SupportRequestRecord = {
  id: string;
  body: string;
  status: "open" | "reviewed";
  createdAt: string;
};

export type UserSettingsRecord = {
  theme: "light" | "dark" | "system";
  notifications: boolean;
  dateFormat: string;
  defaultExport: "xlsx" | "csv" | "json";
  viewerDensity: "comfortable" | "compact";
};

// Static connector catalogue. This is NOT user data — it is the list of
// integrations DocuCoreX supports. Per-workspace connection state (status +
// config) is layered on top from the database.
const INTEGRATION_CATALOG: Array<{ id: string; name: string; category: string }> = [
  { id: "quickbooks", name: "QuickBooks Online", category: "Accounting" },
  { id: "google-sheets", name: "Google Sheets", category: "Export" },
  { id: "google-drive", name: "Google Drive", category: "Cloud storage" },
  { id: "onedrive", name: "OneDrive", category: "Cloud storage" },
  { id: "dropbox", name: "Dropbox", category: "Cloud storage" },
  { id: "webhooks", name: "Webhooks", category: "Developer" },
];

function defaultUserSettings(): UserSettingsRecord {
  return {
    theme: "system",
    notifications: true,
    dateFormat: "DD/MM/YYYY",
    defaultExport: "xlsx",
    viewerDensity: "comfortable",
  };
}

function catalogIntegrations(): IntegrationRecord[] {
  const now = new Date().toISOString();
  return INTEGRATION_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    category: entry.category,
    status: "ready_to_connect" as const,
    config: {},
    updatedAt: now,
  }));
}

// ── Access resolution ──────────────────────────────────────────────────────
// SECURITY (P0 data isolation): settings/team/integrations/automations are
// workspace- or user-scoped. There is NO shared global store. Access resolves
// to one of:
//   - a live workspace context (Supabase configured + authenticated), or
//   - demo mode (ONLY when no Supabase backend is configured), or
//   - null → the caller MUST return 401 (configured but not authenticated).

type LiveAccess = {
  mode: "live";
  workspaceId: string;
  userId: string;
  supabase: Awaited<ReturnType<typeof getWorkspaceContext>> extends infer C
    ? C extends { supabase: infer S }
      ? S
      : never
    : never;
};
type DemoAccess = { mode: "demo" };
export type SettingsAccess = LiveAccess | DemoAccess;

export async function getSettingsAccess(): Promise<SettingsAccess | null> {
  // Demo mode is only possible with no real backend at all.
  if (!isSupabaseConfigured) {
    return { mode: "demo" };
  }

  // Supabase is configured — a real authenticated session is mandatory.
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return null; // caller returns 401 — never fall back to shared data
  }

  return {
    mode: "live",
    workspaceId: context.workspaceId,
    userId: context.userId,
    supabase: context.supabase as LiveAccess["supabase"],
  };
}

// ── Demo store (local dev only, NO Supabase) ───────────────────────────────
// Single-tenant local development store. Seeded with NEUTRAL defaults only —
// never any real person's data. Never reachable when Supabase is configured.
type DemoStore = {
  teamMembers: TeamMemberRecord[];
  integrations: IntegrationRecord[];
  automationPipelines: AutomationPipelineRecord[];
  supportRequests: SupportRequestRecord[];
  userSettings: UserSettingsRecord;
};
const globalDemo = globalThis as typeof globalThis & { __docucorexDemoSettings?: DemoStore };
function demoStore(): DemoStore {
  return (
    globalDemo.__docucorexDemoSettings ??
    (globalDemo.__docucorexDemoSettings = {
      teamMembers: [],
      integrations: catalogIntegrations(),
      automationPipelines: [],
      supportRequests: [],
      userSettings: defaultUserSettings(),
    })
  );
}

// ── Team ───────────────────────────────────────────────────────────────────

type TeamRow = { id: string; email: string; role: string; status: string; user_id: string | null };

function mapTeamRow(row: TeamRow): TeamMemberRecord {
  const roles = ["Owner", "Admin", "Finance", "Auditor", "Viewer"] as const;
  const role = (roles as readonly string[]).includes(row.role) ? (row.role as TeamMemberRecord["role"]) : "Viewer";
  return {
    id: row.id,
    name: row.email.split("@")[0],
    email: row.email,
    role,
    status: row.status === "Invited" ? "Invited" : "Active",
  };
}

export async function getTeamMembers(access: SettingsAccess): Promise<TeamMemberRecord[]> {
  if (access.mode === "demo") return demoStore().teamMembers;
  const { data, error } = await access.supabase
    .from("team_members")
    .select("id, email, role, status, user_id")
    .eq("workspace_id", access.workspaceId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return (data as TeamRow[]).map(mapTeamRow);
}

export async function inviteTeamMember(
  access: SettingsAccess,
  email: string,
  role: TeamMemberRecord["role"],
): Promise<TeamMemberRecord> {
  if (access.mode === "demo") {
    const member: TeamMemberRecord = { id: `invite_${Date.now()}`, name: email.split("@")[0], email, role, status: "Invited" };
    demoStore().teamMembers.unshift(member);
    return member;
  }
  const { data, error } = await access.supabase
    .from("team_members")
    .upsert(
      { workspace_id: access.workspaceId, email, role, status: "Invited" },
      { onConflict: "workspace_id,email" },
    )
    .select("id, email, role, status, user_id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Unable to invite member");
  return mapTeamRow(data as TeamRow);
}

export type TeamMutationResult =
  | { ok: true; member?: TeamMemberRecord }
  | { ok: false; status: number; error: string };

export async function updateTeamMemberRole(
  access: SettingsAccess,
  id: string,
  role: TeamMemberRecord["role"],
): Promise<TeamMutationResult> {
  const members = await getTeamMembers(access);
  const target = members.find((member) => member.id === id);
  if (!target) return { ok: false, status: 404, error: "Member not found" };

  // Don't allow demoting the only Owner — a workspace must always have one.
  if (target.role === "Owner" && role !== "Owner") {
    const owners = members.filter((member) => member.role === "Owner").length;
    if (owners <= 1) {
      return { ok: false, status: 409, error: "Assign another Owner before changing this role." };
    }
  }

  if (access.mode === "demo") {
    const member = demoStore().teamMembers.find((item) => item.id === id);
    if (member) member.role = role;
    return { ok: true, member: member ?? undefined };
  }

  const { data, error } = await access.supabase
    .from("team_members")
    .update({ role })
    .eq("workspace_id", access.workspaceId)
    .eq("id", id)
    .select("id, email, role, status, user_id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Member not found" };
  return { ok: true, member: mapTeamRow(data as TeamRow) };
}

export async function removeTeamMember(access: SettingsAccess, id: string): Promise<TeamMutationResult> {
  const members = await getTeamMembers(access);
  const target = members.find((member) => member.id === id);
  if (!target) return { ok: false, status: 404, error: "Member not found" };

  // Never remove the last Owner.
  if (target.role === "Owner") {
    const owners = members.filter((member) => member.role === "Owner").length;
    if (owners <= 1) {
      return { ok: false, status: 409, error: "Transfer ownership before removing the last Owner." };
    }
  }

  if (access.mode === "demo") {
    const store = demoStore();
    store.teamMembers = store.teamMembers.filter((item) => item.id !== id);
    return { ok: true };
  }

  const { error } = await access.supabase
    .from("team_members")
    .delete()
    .eq("workspace_id", access.workspaceId)
    .eq("id", id);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}

// ── Integrations ────────────────────────────────────────────────────────────

type IntegrationRow = { provider: string; category: string; status: string; config: Record<string, string> | null; updated_at: string };

export async function getIntegrations(access: SettingsAccess): Promise<IntegrationRecord[]> {
  if (access.mode === "demo") return demoStore().integrations;
  const { data } = await access.supabase
    .from("integrations")
    .select("provider, category, status, config, updated_at")
    .eq("workspace_id", access.workspaceId);
  const byProvider = new Map((data as IntegrationRow[] | null ?? []).map((row) => [row.provider, row]));
  // Merge the static catalogue with this workspace's saved connection state.
  return INTEGRATION_CATALOG.map((entry) => {
    const row = byProvider.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      status: (row?.status as IntegrationRecord["status"]) ?? "ready_to_connect",
      config: row?.config ?? {},
      updatedAt: row?.updated_at ?? new Date().toISOString(),
    };
  });
}

export async function updateIntegration(
  access: SettingsAccess,
  id: string,
  status: IntegrationRecord["status"] | undefined,
  config: Record<string, string> | undefined,
): Promise<IntegrationRecord | null> {
  const entry = INTEGRATION_CATALOG.find((item) => item.id === id);
  if (!entry) return null;

  if (access.mode === "demo") {
    const integration = demoStore().integrations.find((item) => item.id === id);
    if (!integration) return null;
    integration.status = status ?? (integration.status === "connected" ? "ready_to_connect" : "connected");
    integration.config = config ?? integration.config;
    integration.updatedAt = new Date().toISOString();
    return integration;
  }

  const nextStatus = status ?? "connected";
  const { data, error } = await access.supabase
    .from("integrations")
    .upsert(
      {
        workspace_id: access.workspaceId,
        provider: id,
        category: entry.category,
        status: nextStatus,
        config: config ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,provider" },
    )
    .select("provider, category, status, config, updated_at")
    .single();
  if (error || !data) return null;
  const row = data as IntegrationRow;
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    status: (row.status as IntegrationRecord["status"]) ?? "ready_to_connect",
    config: row.config ?? {},
    updatedAt: row.updated_at,
  };
}

// ── Automations & support ────────────────────────────────────────────────────

type PipelineRow = { id: string; name: string; input: unknown; output: unknown; active: boolean; created_at: string };
type SupportRow = { id: string; body: string; status: string; created_at: string };

function pipelineText(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export async function getAutomationState(
  access: SettingsAccess,
): Promise<{ pipelines: AutomationPipelineRecord[]; requests: SupportRequestRecord[] }> {
  if (access.mode === "demo") {
    const store = demoStore();
    return { pipelines: store.automationPipelines, requests: store.supportRequests };
  }
  const [pipelinesResult, requestsResult] = await Promise.all([
    access.supabase
      .from("automation_pipelines")
      .select("id, name, input, output, active, created_at")
      .eq("workspace_id", access.workspaceId)
      .order("created_at", { ascending: false }),
    access.supabase
      .from("support_requests")
      .select("id, body, status, created_at")
      .eq("workspace_id", access.workspaceId)
      .order("created_at", { ascending: false }),
  ]);
  const pipelines = ((pipelinesResult.data as PipelineRow[] | null) ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    input: pipelineText(row.input, "Manual uploads"),
    output: pipelineText(row.output, "Document library"),
    active: row.active,
    createdAt: row.created_at,
  }));
  const requests = ((requestsResult.data as SupportRow[] | null) ?? []).map((row) => ({
    id: row.id,
    body: row.body,
    status: row.status === "reviewed" ? ("reviewed" as const) : ("open" as const),
    createdAt: row.created_at,
  }));
  return { pipelines, requests };
}

export async function createAutomationPipeline(
  access: SettingsAccess,
  input: { name: string; input: string; output: string },
): Promise<AutomationPipelineRecord> {
  if (access.mode === "demo") {
    const pipeline: AutomationPipelineRecord = { id: `pipeline_${Date.now()}`, ...input, active: true, createdAt: new Date().toISOString() };
    demoStore().automationPipelines.unshift(pipeline);
    return pipeline;
  }
  const { data, error } = await access.supabase
    .from("automation_pipelines")
    .insert({ workspace_id: access.workspaceId, name: input.name, input: input.input, output: input.output, active: true })
    .select("id, name, input, output, active, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Unable to create pipeline");
  const row = data as PipelineRow;
  return { id: row.id, name: row.name, input: input.input, output: input.output, active: row.active, createdAt: row.created_at };
}

export async function toggleAutomationPipeline(access: SettingsAccess, id: string): Promise<AutomationPipelineRecord | null> {
  if (access.mode === "demo") {
    const pipeline = demoStore().automationPipelines.find((item) => item.id === id);
    if (!pipeline) return null;
    pipeline.active = !pipeline.active;
    return pipeline;
  }
  const { data: current } = await access.supabase
    .from("automation_pipelines")
    .select("id, name, input, output, active, created_at")
    .eq("workspace_id", access.workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (!current) return null;
  const row = current as PipelineRow;
  const { data, error } = await access.supabase
    .from("automation_pipelines")
    .update({ active: !row.active, updated_at: new Date().toISOString() })
    .eq("workspace_id", access.workspaceId)
    .eq("id", id)
    .select("id, name, input, output, active, created_at")
    .single();
  if (error || !data) return null;
  const updated = data as PipelineRow;
  return {
    id: updated.id,
    name: updated.name,
    input: pipelineText(updated.input, "Manual uploads"),
    output: pipelineText(updated.output, "Document library"),
    active: updated.active,
    createdAt: updated.created_at,
  };
}

export async function createSupportRequest(access: SettingsAccess, body: string): Promise<SupportRequestRecord> {
  if (access.mode === "demo") {
    const request: SupportRequestRecord = { id: `request_${Date.now()}`, body, status: "open", createdAt: new Date().toISOString() };
    demoStore().supportRequests.unshift(request);
    return request;
  }
  const { data, error } = await access.supabase
    .from("support_requests")
    .insert({ workspace_id: access.workspaceId, body, status: "open" })
    .select("id, body, status, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Unable to create request");
  const row = data as SupportRow;
  return { id: row.id, body: row.body, status: "open", createdAt: row.created_at };
}

// ── User settings ────────────────────────────────────────────────────────────

type SettingsRow = { theme: string; notifications: boolean; date_format: string; default_export: string; viewer_density: string };

function mapSettingsRow(row: SettingsRow): UserSettingsRecord {
  return {
    theme: (["light", "dark", "system"].includes(row.theme) ? row.theme : "system") as UserSettingsRecord["theme"],
    notifications: Boolean(row.notifications),
    dateFormat: row.date_format || "DD/MM/YYYY",
    defaultExport: (["xlsx", "csv", "json"].includes(row.default_export) ? row.default_export : "xlsx") as UserSettingsRecord["defaultExport"],
    viewerDensity: (row.viewer_density === "compact" ? "compact" : "comfortable") as UserSettingsRecord["viewerDensity"],
  };
}

export async function getUserSettings(access: SettingsAccess): Promise<UserSettingsRecord> {
  if (access.mode === "demo") return demoStore().userSettings;
  const { data } = await access.supabase
    .from("user_settings")
    .select("theme, notifications, date_format, default_export, viewer_density")
    .eq("user_id", access.userId)
    .maybeSingle();
  if (!data) return defaultUserSettings();
  return mapSettingsRow(data as SettingsRow);
}

export async function updateUserSettings(access: SettingsAccess, patch: Partial<UserSettingsRecord>): Promise<UserSettingsRecord> {
  if (access.mode === "demo") {
    Object.assign(demoStore().userSettings, patch);
    return demoStore().userSettings;
  }
  const current = await getUserSettings(access);
  const next = { ...current, ...patch };
  const { data, error } = await access.supabase
    .from("user_settings")
    .upsert(
      {
        user_id: access.userId,
        workspace_id: access.workspaceId,
        theme: next.theme,
        notifications: next.notifications,
        date_format: next.dateFormat,
        default_export: next.defaultExport,
        viewer_density: next.viewerDensity,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select("theme, notifications, date_format, default_export, viewer_density")
    .single();
  if (error || !data) return next;
  return mapSettingsRow(data as SettingsRow);
}

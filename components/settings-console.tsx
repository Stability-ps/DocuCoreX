"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  Copy,
  CreditCard,
  Database,
  Globe,
  Key,
  LayoutDashboard,
  Menu,
  Palette,
  Plus,
  Shield,
  ShieldCheck,
  Smartphone,
  Trash2,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { UserSettingsRecord } from "@/lib/app-state";

// ─── Types ────────────────────────────────────────────────────────────────────

type Section =
  | "overview"
  | "workspace"
  | "profile"
  | "appearance"
  | "notifications"
  | "security"
  | "audit-logs"
  | "team"
  | "storage"
  | "ocr-ai"
  | "integrations"
  | "api-keys"
  | "billing"
  | "danger";

type ProfileState = { fullName: string; company: string; role: string };

type ApiKey = {
  id: string;
  name: string;
  lastFour?: string;
  last_four?: string;
  lastUsedAt?: string | null;
  last_used_at?: string | null;
  revokedAt?: string | null;
  revoked_at?: string | null;
  createdAt?: string;
  created_at?: string;
};

type AuditLog = {
  id: string;
  actor?: string;
  action: string;
  entityType?: string;
  entity_type?: string;
  createdAt?: string;
  created_at?: string;
};

type ProfilePayload = {
  profile: {
    fullName?: string;
    full_name?: string;
    company?: string;
    role?: string;
    twoFactorEnabled?: boolean;
    two_factor_enabled?: boolean;
  };
  mode?: string;
};

// ─── Navigation ───────────────────────────────────────────────────────────────

const NAV_GROUPS: Array<{
  label: string | null;
  items: Array<{ id: Section; label: string; icon: React.ElementType; danger?: boolean }>;
}> = [
  {
    label: null,
    items: [{ id: "overview", label: "Overview", icon: LayoutDashboard }],
  },
  {
    label: "General",
    items: [
      { id: "workspace", label: "Workspace", icon: Globe },
      { id: "profile", label: "Profile", icon: User },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "notifications", label: "Notifications", icon: Activity },
    ],
  },
  {
    label: "Security",
    items: [
      { id: "security", label: "Security", icon: Shield },
      { id: "audit-logs", label: "Audit Logs", icon: ShieldCheck },
    ],
  },
  {
    label: "Collaboration",
    items: [{ id: "team", label: "Team & Permissions", icon: Users }],
  },
  {
    label: "Platform",
    items: [
      { id: "storage", label: "Storage", icon: Database },
      { id: "ocr-ai", label: "OCR & AI", icon: Bot },
      { id: "integrations", label: "Integrations", icon: Globe },
      { id: "api-keys", label: "API & Webhooks", icon: Key },
    ],
  },
  {
    label: "Account",
    items: [{ id: "billing", label: "Billing & Usage", icon: CreditCard }],
  },
  {
    label: "Advanced",
    items: [{ id: "danger", label: "Danger Zone", icon: AlertTriangle, danger: true }],
  },
];

// ─── Shared UI components ─────────────────────────────────────────────────────

type BadgeVariant = "healthy" | "warning" | "error" | "inactive" | "info";

function StatusBadge({ label, variant = "healthy" }: { label: string; variant?: BadgeVariant }) {
  const styles: Record<BadgeVariant, string> = {
    healthy: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    warning: "bg-amber-50 text-amber-700 ring-amber-200",
    error: "bg-rose-50 text-rose-700 ring-rose-200",
    inactive: "bg-slate-100 text-slate-500 ring-slate-200",
    info: "bg-blue-50 text-blue-700 ring-blue-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${styles[variant]}`}>
      {label}
    </span>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-b border-slate-100 pb-6">
      <h1 className="text-xl font-bold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
  last = false,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-8 py-5 ${last ? "" : "border-b border-slate-100"}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ActionButton({
  onClick,
  variant = "secondary",
  children,
  disabled = false,
}: {
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const base = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50";
  const variants = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
    danger: "border border-rose-200 bg-white text-rose-600 hover:bg-rose-50",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function SettingsConsole() {
  const [section, setSection] = useState<Section>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileState>({ fullName: "", company: "", role: "" });
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [newSecret, setNewSecret] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [userSettings, setUserSettings] = useState<UserSettingsRecord>({
    theme: "system",
    notifications: true,
    dateFormat: "DD/MM/YYYY",
    defaultExport: "xlsx",
    viewerDensity: "comfortable",
  });

  useEffect(() => {
    async function load() {
      const [profileRes, keysRes, auditRes, settingsRes] = await Promise.all([
        fetch("/api/profile"),
        fetch("/api/api-keys"),
        fetch("/api/audit-logs"),
        fetch("/api/user-settings"),
      ]);
      if (profileRes.ok) {
        const data = (await profileRes.json()) as { profile: ProfilePayload["profile"] };
        setProfile({
          fullName: data.profile.fullName ?? data.profile.full_name ?? "",
          company: data.profile.company ?? "",
          role: data.profile.role ?? "",
        });
      }
      if (keysRes.ok) {
        const data = (await keysRes.json()) as { apiKeys: ApiKey[] };
        setApiKeys(data.apiKeys ?? []);
      }
      if (auditRes.ok) {
        const data = (await auditRes.json()) as { auditLogs: AuditLog[] };
        setAuditLogs(data.auditLogs ?? []);
      }
      if (settingsRes.ok) {
        const data = (await settingsRes.json()) as { settings: UserSettingsRecord };
        setUserSettings(data.settings);
      }
    }
    void load();
  }, []);

  const saveProfile = useCallback(async () => {
    setSaveStatus("saving");
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    setSaveStatus(res.ok ? "saved" : "error");
    setTimeout(() => setSaveStatus("idle"), 2500);
  }, [profile]);

  const saveSettings = useCallback(
    async (patch: Partial<UserSettingsRecord>) => {
      const next = { ...userSettings, ...patch };
      setUserSettings(next);
      await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
    },
    [userSettings],
  );

  const applyTheme = useCallback((theme: UserSettingsRecord["theme"]) => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.body.classList.add("bg-slate-950");
    } else {
      document.documentElement.classList.remove("dark");
      document.body.classList.remove("bg-slate-950");
    }
  }, []);

  const createApiKey = useCallback(async () => {
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace automation key" }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { apiKey: ApiKey; secret: string };
    setApiKeys((k) => [data.apiKey, ...k]);
    setNewSecret(data.secret);
  }, []);

  const revokeApiKey = useCallback(async (id: string, revoked: boolean) => {
    const res = await fetch("/api/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, revoked }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { apiKey: ApiKey };
    setApiKeys((k) => k.map((key) => (key.id === id ? data.apiKey : key)));
  }, []);

  function navigate(s: Section) {
    setSection(s);
    setSidebarOpen(false);
  }

  const shared = {
    profile,
    setProfile,
    saveProfile,
    saveStatus,
    userSettings,
    saveSettings,
    applyTheme,
    apiKeys,
    newSecret,
    createApiKey,
    revokeApiKey,
    auditLogs,
    onNavigate: navigate,
  };

  return (
    <div className="flex bg-white" style={{ minHeight: "calc(100vh - 80px)" }}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Settings sidebar */}
      <aside
        className={`fixed inset-y-0 left-72 z-50 flex w-60 flex-col border-r border-slate-100 bg-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-slate-100 px-4 lg:hidden">
          <span className="text-sm font-bold text-slate-900">Settings</span>
          <button onClick={() => setSidebarOpen(false)}>
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="hidden h-14 items-center border-b border-slate-100 px-5 lg:flex">
          <span className="text-sm font-bold text-slate-500">Settings</span>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi} className="mb-1">
              {group.label && (
                <p className="mb-1 px-4 pt-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  {group.label}
                </p>
              )}
              {group.items.map((item) => {
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`mx-2 flex w-[calc(100%-16px)] items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                      active
                        ? "bg-slate-100 font-semibold text-slate-900"
                        : item.danger
                        ? "font-medium text-rose-600 hover:bg-rose-50"
                        : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    <item.icon
                      className={`h-4 w-4 shrink-0 ${
                        active ? "text-slate-700" : item.danger ? "text-rose-500" : "text-slate-400"
                      }`}
                    />
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 lg:hidden">
          <button onClick={() => setSidebarOpen(true)} className="rounded-lg p-1.5 hover:bg-slate-100">
            <Menu className="h-5 w-5 text-slate-600" />
          </button>
          <span className="text-sm font-semibold text-slate-700">
            {NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === section)?.label ?? "Settings"}
          </span>
        </div>

        <div className="mx-auto max-w-3xl px-6 py-10">
          {section === "overview" && <OverviewSection {...shared} />}
          {section === "workspace" && <WorkspaceSection {...shared} />}
          {section === "profile" && <ProfileSection {...shared} />}
          {section === "appearance" && <AppearanceSection {...shared} />}
          {section === "notifications" && <NotificationsSection {...shared} />}
          {section === "security" && <SecuritySection />}
          {section === "audit-logs" && <AuditLogsSection auditLogs={shared.auditLogs} />}
          {section === "team" && <TeamSection />}
          {section === "storage" && <StorageSection />}
          {section === "ocr-ai" && <OcrAiSection />}
          {section === "integrations" && <IntegrationsSection />}
          {section === "api-keys" && (
            <ApiKeysSection
              apiKeys={shared.apiKeys}
              newSecret={shared.newSecret}
              createApiKey={shared.createApiKey}
              revokeApiKey={shared.revokeApiKey}
            />
          )}
          {section === "billing" && <BillingSection />}
          {section === "danger" && <DangerSection />}
        </div>
      </main>
    </div>
  );
}

// ─── Shared props type ────────────────────────────────────────────────────────

type SharedProps = {
  profile: ProfileState;
  setProfile: React.Dispatch<React.SetStateAction<ProfileState>>;
  saveProfile: () => Promise<void>;
  saveStatus: "idle" | "saving" | "saved" | "error";
  userSettings: UserSettingsRecord;
  saveSettings: (patch: Partial<UserSettingsRecord>) => Promise<void>;
  applyTheme: (theme: UserSettingsRecord["theme"]) => void;
  apiKeys: ApiKey[];
  newSecret: string;
  createApiKey: () => Promise<void>;
  revokeApiKey: (id: string, revoked: boolean) => Promise<void>;
  auditLogs: AuditLog[];
  onNavigate: (s: Section) => void;
};

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewSection({ auditLogs, apiKeys, onNavigate }: SharedProps) {
  const health = [
    { label: "Workspace Status", value: "Healthy", badge: "healthy" as BadgeVariant, detail: "All systems operational" },
    { label: "Security Score", value: "Needs Attention", badge: "warning" as BadgeVariant, detail: "Two-factor auth not enabled" },
    { label: "Storage", value: "Available", badge: "healthy" as BadgeVariant, detail: "Supabase Storage configured" },
    { label: "AI Engine", value: "Ready", badge: "healthy" as BadgeVariant, detail: "Connected to AI provider" },
    { label: "OCR Engine", value: "Ready", badge: "healthy" as BadgeVariant, detail: "Processing normally" },
    {
      label: "API Keys",
      value: apiKeys.filter((k) => !k.revokedAt && !k.revoked_at).length > 0
        ? `${apiKeys.filter((k) => !k.revokedAt && !k.revoked_at).length} active`
        : "None",
      badge: (apiKeys.length > 0 ? "info" : "inactive") as BadgeVariant,
      detail: apiKeys.length > 0 ? "Developer access configured" : "No keys created yet",
    },
  ];

  const quickActions: Array<{ label: string; section: Section; icon: React.ElementType }> = [
    { label: "Edit Profile", section: "profile", icon: User },
    { label: "Generate API Key", section: "api-keys", icon: Key },
    { label: "Enable 2FA", section: "security", icon: Shield },
    { label: "View Audit Logs", section: "audit-logs", icon: ShieldCheck },
    { label: "Team & Permissions", section: "team", icon: Users },
    { label: "Billing & Usage", section: "billing", icon: CreditCard },
  ];

  return (
    <div className="space-y-10">
      <SectionHeader
        title="Settings Overview"
        description="Workspace health, quick actions, and recent activity at a glance."
      />

      <section>
        <h2 className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Workspace Health</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {health.map((item) => (
            <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{item.label}</p>
                <StatusBadge label={item.value} variant={item.badge} />
              </div>
              <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Quick Actions</h2>
        <div className="flex flex-wrap gap-2">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => onNavigate(a.section)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <a.icon className="h-4 w-4 text-slate-400" />
              {a.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-400">Recent Activity</h2>
        {auditLogs.length === 0 ? (
          <p className="text-sm text-slate-400">No recent activity recorded.</p>
        ) : (
          <>
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
              {auditLogs.slice(0, 6).map((log) => (
                <div key={log.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{log.action}</p>
                    <p className="text-xs text-slate-400">
                      {log.actor ?? "System"} · {log.entityType ?? log.entity_type ?? "workspace"}
                    </p>
                  </div>
                  <span className="text-xs text-slate-400">
                    {log.createdAt ?? log.created_at
                      ? new Date((log.createdAt ?? log.created_at) as string).toLocaleDateString()
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
            <button onClick={() => onNavigate("audit-logs")} className="mt-3 text-sm font-medium text-blue-600 hover:text-blue-700">
              View all audit logs →
            </button>
          </>
        )}
      </section>
    </div>
  );
}

// ─── Workspace ────────────────────────────────────────────────────────────────

function WorkspaceSection({ profile, setProfile, saveProfile, saveStatus }: SharedProps) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Workspace" description="Configure your workspace name, company details, and regional settings." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Company name" description="Displayed in reports and shared documents.">
          <input
            className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            value={profile.company}
            onChange={(e) => setProfile((p) => ({ ...p, company: e.target.value }))}
          />
        </SettingRow>
        <SettingRow label="Default timezone" description="Used for scheduled jobs and audit timestamps.">
          <select className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400">
            <option>UTC</option>
            <option>Africa/Johannesburg</option>
            <option>Europe/London</option>
            <option>America/New_York</option>
          </select>
        </SettingRow>
        <SettingRow label="Default OCR language" description="Primary language when processing documents.">
          <select className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400">
            <option>English</option>
            <option>Afrikaans</option>
            <option>French</option>
            <option>German</option>
            <option>Spanish</option>
          </select>
        </SettingRow>
        <SettingRow label="Date format" description="Applies to exports and document metadata." last>
          <select className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400">
            <option>DD/MM/YYYY</option>
            <option>MM/DD/YYYY</option>
            <option>YYYY-MM-DD</option>
          </select>
        </SettingRow>
      </div>
      <div className="flex items-center gap-3">
        <ActionButton variant="primary" onClick={saveProfile} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : "Save changes"}
        </ActionButton>
        {saveStatus === "error" && <p className="text-sm text-rose-600">Failed to save. Please try again.</p>}
      </div>
    </div>
  );
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function ProfileSection({ profile, setProfile, saveProfile, saveStatus }: SharedProps) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Profile" description="Your personal account information visible to your team." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Full name" description="Displayed in comments, assignments, and notifications.">
          <input
            className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            value={profile.fullName}
            onChange={(e) => setProfile((p) => ({ ...p, fullName: e.target.value }))}
          />
        </SettingRow>
        <SettingRow label="Role" description="Your role within this workspace.">
          <input
            className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            value={profile.role}
            onChange={(e) => setProfile((p) => ({ ...p, role: e.target.value }))}
          />
        </SettingRow>
        <SettingRow label="Email address" description="Managed by your authentication provider." last>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">Supabase Auth</span>
            <StatusBadge label="Verified" variant="healthy" />
          </div>
        </SettingRow>
      </div>
      <div className="flex items-center gap-3">
        <ActionButton variant="primary" onClick={saveProfile} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : "Save changes"}
        </ActionButton>
        {saveStatus === "error" && <p className="text-sm text-rose-600">Failed to save. Please try again.</p>}
      </div>
    </div>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

function AppearanceSection({ userSettings, saveSettings, applyTheme }: SharedProps) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Appearance" description="Personalise how DocuCoreX looks and feels for you." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Theme" description="Light, dark, or match your system preference.">
          <div className="flex gap-2">
            {(["light", "dark", "system"] as UserSettingsRecord["theme"][]).map((t) => (
              <button
                key={t}
                onClick={() => { applyTheme(t); void saveSettings({ theme: t }); }}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition ${
                  userSettings.theme === t
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Viewer density" description="Controls spacing in the document viewer.">
          <div className="flex gap-2">
            {(["comfortable", "compact"] as UserSettingsRecord["viewerDensity"][]).map((d) => (
              <button
                key={d}
                onClick={() => void saveSettings({ viewerDensity: d })}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition ${
                  userSettings.viewerDensity === d
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Default export format" description="File format used when downloading extracted data." last>
          <select
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400"
            value={userSettings.defaultExport}
            onChange={(e) => void saveSettings({ defaultExport: e.target.value as UserSettingsRecord["defaultExport"] })}
          >
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </SettingRow>
      </div>
      <p className="text-xs text-slate-400">Appearance preferences are saved automatically.</p>
    </div>
  );
}

// ─── Notifications ────────────────────────────────────────────────────────────

function NotificationsSection({ userSettings, saveSettings }: SharedProps) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Notifications" description="Control when and how DocuCoreX alerts you." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Processing notifications" description="Alerts when documents finish OCR, extraction, or conversion.">
          <Toggle
            on={userSettings.notifications}
            onChange={() => void saveSettings({ notifications: !userSettings.notifications })}
          />
        </SettingRow>
        <SettingRow label="Team activity" description="Alerts when members upload, share, or comment.">
          <div className="flex items-center gap-2">
            <Toggle on={false} onChange={() => undefined} disabled />
            <StatusBadge label="Coming soon" variant="inactive" />
          </div>
        </SettingRow>
        <SettingRow label="Security alerts" description="Immediate alerts for new sign-ins and permission changes." last>
          <div className="flex items-center gap-2">
            <Toggle on={true} onChange={() => undefined} />
            <StatusBadge label="Recommended" variant="info" />
          </div>
        </SettingRow>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, disabled = false }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:opacity-50 ${on ? "bg-blue-600" : "bg-slate-200"}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// ─── Security ─────────────────────────────────────────────────────────────────

function SecuritySection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Security" description="Authentication methods, active sessions, and access controls." />

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Password</h3>
        <div className="rounded-xl border border-slate-100">
          <SettingRow label="Password" description="Keep your password strong and unique.">
            <ActionButton>Change password</ActionButton>
          </SettingRow>
          <SettingRow label="Recovery codes" description="Emergency codes if you lose access to your 2FA device." last>
            <div className="flex items-center gap-2">
              <ActionButton>Generate codes</ActionButton>
              <StatusBadge label="Not set" variant="inactive" />
            </div>
          </SettingRow>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Two-Factor Authentication</h3>
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-amber-100 p-1.5">
                <Smartphone className="h-4 w-4 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900">Two-factor authentication is off</p>
                <p className="mt-0.5 text-sm text-amber-700">Protect your account with an authenticator app or hardware security key.</p>
              </div>
            </div>
            <StatusBadge label="Disabled" variant="warning" />
          </div>
          <div className="mt-4">
            <ActionButton variant="primary">Enable 2FA</ActionButton>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Active Sessions</h3>
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          <div className="flex items-center justify-between px-4 py-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-slate-800">Current session</p>
                <StatusBadge label="Active" variant="healthy" />
              </div>
              <p className="mt-0.5 text-xs text-slate-400">Browser · This device · DocuCoreX Web</p>
            </div>
            <ActionButton variant="danger">Revoke</ActionButton>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Single Sign-On</h3>
        <div className="rounded-xl border border-slate-100 px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-800">SAML / OIDC provider</p>
              <p className="text-sm text-slate-500">Connect your identity provider for centralised login.</p>
            </div>
            <StatusBadge label="Coming soon" variant="inactive" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Audit Logs ───────────────────────────────────────────────────────────────

function AuditLogsSection({ auditLogs }: { auditLogs: AuditLog[] }) {
  return (
    <div className="space-y-8">
      <SectionHeader title="Audit Logs" description="A chronological record of all security and processing events." />
      {auditLogs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center">
          <ShieldCheck className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          <p className="text-sm font-semibold text-slate-400">No audit events yet</p>
          <p className="mt-1 text-xs text-slate-400">Events appear here as your team uses the platform.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {auditLogs.map((log) => (
            <div key={log.id} className="flex items-start justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-800">{log.action}</p>
                <p className="text-xs text-slate-400">
                  {log.actor ?? "System"} · {log.entityType ?? log.entity_type ?? "workspace"}
                </p>
              </div>
              <span className="shrink-0 text-xs text-slate-400">
                {log.createdAt ?? log.created_at
                  ? new Date((log.createdAt ?? log.created_at) as string).toLocaleString()
                  : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Team ─────────────────────────────────────────────────────────────────────

function TeamSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Team & Permissions" description="Manage who has access and what they can do." />
      <div className="rounded-xl border border-slate-100 p-6 text-center">
        <Users className="mx-auto mb-3 h-8 w-8 text-slate-300" />
        <p className="text-sm font-semibold text-slate-700">Manage your team</p>
        <p className="mt-1 text-sm text-slate-500">Invite members, assign roles, and control access from the Team page.</p>
        <div className="mt-5">
          <Link href="/team" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700">
            Open Team settings <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function StorageSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Storage" description="Storage usage, retention policies, and version history." />
      <div className="grid gap-4 sm:grid-cols-3">
        {["Used", "Available", "Files"].map((label) => (
          <div key={label} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-2 text-2xl font-bold text-slate-400">—</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Retention policy" description="Automatically archive or delete documents after a set period.">
          <StatusBadge label="Not configured" variant="inactive" />
        </SettingRow>
        <SettingRow label="Version history" description="Retain previous versions of processed documents." last>
          <StatusBadge label="Coming soon" variant="inactive" />
        </SettingRow>
      </div>
    </div>
  );
}

// ─── OCR & AI ─────────────────────────────────────────────────────────────────

function OcrAiSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="OCR & AI" description="Configure the OCR engine, AI model, and document intelligence." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="OCR engine" description="Text extraction engine for uploaded documents.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Supabase Edge</span>
            <StatusBadge label="Ready" variant="healthy" />
          </div>
        </SettingRow>
        <SettingRow label="AI model" description="Language model for summarisation and Q&A.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">GPT-4o</span>
            <StatusBadge label="Ready" variant="healthy" />
          </div>
        </SettingRow>
        <SettingRow label="Semantic search index" description="Vector index for semantic document search." last>
          <StatusBadge label="Coming soon" variant="inactive" />
        </SettingRow>
      </div>
    </div>
  );
}

// ─── Integrations ─────────────────────────────────────────────────────────────

function IntegrationsSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Integrations" description="Connect to accounting platforms, cloud storage, and business tools." />
      <div className="rounded-xl border border-slate-100 p-6 text-center">
        <Zap className="mx-auto mb-3 h-8 w-8 text-slate-300" />
        <p className="text-sm font-semibold text-slate-700">Manage integrations</p>
        <p className="mt-1 text-sm text-slate-500">Connect cloud storage, accounting systems, and webhooks from the Integrations page.</p>
        <div className="mt-5">
          <Link href="/integrations" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700">
            Open Integrations <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

function ApiKeysSection({
  apiKeys,
  newSecret,
  createApiKey,
  revokeApiKey,
}: {
  apiKeys: ApiKey[];
  newSecret: string;
  createApiKey: () => Promise<void>;
  revokeApiKey: (id: string, revoked: boolean) => Promise<void>;
}) {
  return (
    <div className="space-y-8">
      <SectionHeader title="API & Webhooks" description="Authenticate programmatic access and receive real-time event webhooks." />

      {newSecret && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-amber-700">Save this key — shown once only</p>
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-800">{newSecret}</code>
            <button
              onClick={() => void navigator.clipboard.writeText(newSecret)}
              className="shrink-0 text-slate-400 transition hover:text-slate-700"
              title="Copy"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-800">API Keys</p>
          <p className="text-sm text-slate-500">
            {apiKeys.filter((k) => !k.revokedAt && !k.revoked_at).length} active ·{" "}
            {apiKeys.filter((k) => k.revokedAt || k.revoked_at).length} revoked
          </p>
        </div>
        <ActionButton variant="primary" onClick={createApiKey}>
          <Plus className="h-4 w-4" />
          Create key
        </ActionButton>
      </div>

      {apiKeys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
          <Key className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          <p className="text-sm font-semibold text-slate-400">No API keys yet</p>
          <p className="mt-1 text-xs text-slate-400">Create a key to authenticate programmatic access.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {apiKeys.map((key) => {
            const revoked = !!(key.revokedAt || key.revoked_at);
            return (
              <div key={key.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-800">{key.name}</p>
                    <StatusBadge label={revoked ? "Revoked" : "Active"} variant={revoked ? "error" : "healthy"} />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">
                    ····{key.lastFour ?? key.last_four ?? "••••"} ·{" "}
                    {key.lastUsedAt ?? key.last_used_at
                      ? `Last used ${new Date((key.lastUsedAt ?? key.last_used_at) as string).toLocaleDateString()}`
                      : "Never used"}
                  </p>
                </div>
                <ActionButton variant={revoked ? "secondary" : "danger"} onClick={() => void revokeApiKey(key.id, !revoked)}>
                  {revoked ? "Restore" : "Revoke"}
                </ActionButton>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-slate-100 px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-800">Webhook Endpoints</p>
            <p className="text-sm text-slate-500">Receive real-time events in your own systems.</p>
          </div>
          <StatusBadge label="Coming soon" variant="inactive" />
        </div>
      </div>
    </div>
  );
}

// ─── Billing ──────────────────────────────────────────────────────────────────

function BillingSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Billing & Usage" description="Subscription plan, invoices, payment methods, and usage quotas." />

      <div className="rounded-xl border border-slate-100 p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current plan</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">Free</p>
            <p className="mt-1 text-sm text-slate-500">Community workspace with core features.</p>
          </div>
          <StatusBadge label="Active" variant="healthy" />
        </div>
        <div className="mt-5">
          <ActionButton variant="primary">
            <CreditCard className="h-4 w-4" />
            Upgrade plan
          </ActionButton>
        </div>
      </div>

      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Invoices" description="Download past invoices for accounting.">
          <StatusBadge label="None" variant="inactive" />
        </SettingRow>
        <SettingRow label="Payment method" description="Saved payment methods for automatic billing." last>
          <StatusBadge label="Not configured" variant="inactive" />
        </SettingRow>
      </div>

      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-semibold text-slate-500">Stripe integration required</p>
        <p className="mt-1 text-xs text-slate-400">Add Stripe environment variables to enable subscriptions, invoicing, and usage-based billing.</p>
      </div>
    </div>
  );
}

// ─── Danger Zone ──────────────────────────────────────────────────────────────

function DangerSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Danger Zone" description="Irreversible actions. Proceed with caution." />
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">Export workspace data</p>
              <p className="mt-0.5 text-sm text-slate-500">Download all documents, extracted data, and settings as a ZIP archive.</p>
            </div>
            <ActionButton variant="secondary">Export</ActionButton>
          </div>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-rose-900">Delete workspace</p>
              <p className="mt-0.5 text-sm text-rose-700">
                Permanently delete this workspace, all documents, extracted data, API keys, and team members.
                <strong className="block mt-1">This action cannot be undone.</strong>
              </p>
            </div>
            <ActionButton variant="danger">
              <Trash2 className="h-4 w-4" />
              Delete
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}

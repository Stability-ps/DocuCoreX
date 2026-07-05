"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Building2,
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
import { supabase, getSiteUrl } from "@/lib/supabase";

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
  | "companies"
  | "storage"
  | "ocr-ai"
  | "integrations"
  | "api-keys"
  | "billing"
  | "danger";

type ProfileState = { fullName: string; company: string; role: string; email: string };

type UsageState = {
  documentsUploaded: number;
  pagesProcessed: number;
  storageBytes: number;
  exportsCreated: number;
  ocrCreditsRemaining: number;
} | null;

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
    label: "Invoicing",
    items: [{ id: "companies", label: "Company Profiles", icon: Building2 }],
  },
  {
    label: "Platform",
    items: [
      { id: "storage", label: "Storage", icon: Database },
      { id: "ocr-ai", label: "OCR & Processing", icon: Bot },
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
  const base = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
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

export function SettingsConsole({ initialSection = "overview" }: { initialSection?: Section }) {
  const [section, setSection] = useState<Section>(initialSection);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileState>({ fullName: "", company: "", role: "", email: "" });
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [newSecret, setNewSecret] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [usage, setUsage] = useState<UsageState>(null);
  const [usageState, setUsageState] = useState<"loading" | "ready" | "error">("loading");
  const [keyName, setKeyName] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettingsRecord>({
    theme: "system",
    notifications: true,
    dateFormat: "DD/MM/YYYY",
    defaultExport: "xlsx",
    viewerDensity: "comfortable",
  });
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    async function load() {
      const [profileRes, keysRes, auditRes, settingsRes] = await Promise.all([
        fetch("/api/profile"),
        fetch("/api/api-keys"),
        fetch("/api/audit-logs"),
        fetch("/api/user-settings"),
      ]);
      if (profileRes.ok) {
        const data = (await profileRes.json()) as { profile: ProfilePayload["profile"] & { email?: string | null } };
        setProfile({
          fullName: data.profile.fullName ?? data.profile.full_name ?? "",
          company: data.profile.company ?? "",
          role: data.profile.role ?? "",
          email: data.profile.email ?? "",
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

  const loadUsage = useCallback(async () => {
    setUsageState("loading");
    try {
      const res = await fetch("/api/usage");
      if (!res.ok) {
        setUsageState("error");
        return;
      }
      const data = (await res.json()) as {
        usage?: {
          documentsUploaded?: number;
          documents_uploaded?: number;
          pagesProcessed?: number;
          pages_processed?: number;
          storageBytes?: number;
          storage_bytes?: number;
          exportsCreated?: number;
          exports_created?: number;
          ocrCreditsRemaining?: number;
          ocr_credits_remaining?: number;
        };
      };
      const u = data.usage ?? {};
      setUsage({
        documentsUploaded: u.documentsUploaded ?? u.documents_uploaded ?? 0,
        pagesProcessed: u.pagesProcessed ?? u.pages_processed ?? 0,
        storageBytes: u.storageBytes ?? u.storage_bytes ?? 0,
        exportsCreated: u.exportsCreated ?? u.exports_created ?? 0,
        ocrCreditsRemaining: u.ocrCreditsRemaining ?? u.ocr_credits_remaining ?? 0,
      });
      setUsageState("ready");
    } catch {
      setUsageState("error");
    }
  }, []);

  useEffect(() => {
    if (section === "storage" || section === "overview") void loadUsage();
  }, [section, loadUsage]);

  useEffect(() => {
    if (!sidebarOpen) {
      document.body.style.overflow = "";
      return;
    }

    document.body.style.overflow = "hidden";
    const drawer = drawerRef.current;
    const firstFocusable = drawer?.querySelector<HTMLElement>("button, a, input, select, textarea, [tabindex]:not([tabindex='-1'])");
    firstFocusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawer) return;

      const focusable = drawer.querySelectorAll<HTMLElement>(
        "button, a, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sidebarOpen]);

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
    if (keyBusy) return;
    setKeyBusy(true);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName.trim() || "Workspace automation key" }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { apiKey: ApiKey; secret: string };
      setApiKeys((k) => [data.apiKey, ...k]);
      setNewSecret(data.secret);
      setKeyName("");
    } finally {
      setKeyBusy(false);
    }
  }, [keyBusy, keyName]);

  const revokeApiKey = useCallback(async (id: string, revoked: boolean) => {
    if (revoked && !window.confirm("Revoke this API key? Any integration using it will stop working immediately.")) {
      return;
    }
    setRevokeBusyId(id);
    try {
      const res = await fetch("/api/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, revoked }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { apiKey: ApiKey };
      setApiKeys((k) => k.map((key) => (key.id === id ? data.apiKey : key)));
    } finally {
      setRevokeBusyId(null);
    }
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
    usage,
    usageState,
    loadUsage,
    onNavigate: navigate,
  };

  return (
    <div className="flex bg-white" style={{ minHeight: "calc(100vh - 80px)" }}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      {/* Settings sidebar */}
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal={sidebarOpen ? "true" : "false"}
        aria-label="Settings navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-xs flex-col border-r border-slate-100 bg-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:max-w-none lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-slate-100 px-4 lg:hidden">
          <span className="text-sm font-bold text-slate-900">Settings</span>
          <button onClick={() => setSidebarOpen(false)} className="min-h-11 min-w-11 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Close settings navigation">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="hidden h-14 items-center border-b border-slate-100 px-5 lg:flex">
          <span className="text-sm font-bold text-slate-500">Settings</span>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 overscroll-contain" style={{ touchAction: "pan-y" }}>
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
                    className={`mx-2 flex min-h-11 w-[calc(100%-16px)] items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
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
          <button onClick={() => setSidebarOpen(true)} className="min-h-11 min-w-11 rounded-lg p-1.5 hover:bg-slate-100" aria-label="Open settings navigation">
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
          {section === "security" && <SecuritySection email={profile.email} />}
          {section === "audit-logs" && <AuditLogsSection auditLogs={shared.auditLogs} />}
          {section === "team" && <TeamSection />}
          {section === "companies" && <CompaniesSection />}
          {section === "storage" && <StorageSection usage={usage} usageState={usageState} loadUsage={loadUsage} />}
          {section === "ocr-ai" && <OcrAiSection />}
          {section === "integrations" && <IntegrationsSection />}
          {section === "api-keys" && (
            <ApiKeysSection
              apiKeys={shared.apiKeys}
              newSecret={shared.newSecret}
              createApiKey={shared.createApiKey}
              revokeApiKey={shared.revokeApiKey}
              keyName={keyName}
              setKeyName={setKeyName}
              keyBusy={keyBusy}
              revokeBusyId={revokeBusyId}
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
  usage: UsageState;
  usageState: "loading" | "ready" | "error";
  loadUsage: () => Promise<void>;
  onNavigate: (s: Section) => void;
};

// ─── Overview ─────────────────────────────────────────────────────────────────

function OverviewSection({ auditLogs, apiKeys, onNavigate }: SharedProps) {
  const activeKeys = apiKeys.filter((k) => !k.revokedAt && !k.revoked_at).length;
  const health = [
    { label: "Workspace Status", value: "Active", badge: "healthy" as BadgeVariant, detail: "Signed in and workspace resolved" },
    { label: "Storage & AI", value: "Server-managed", badge: "info" as BadgeVariant, detail: "OCR & AI run on the worker" },
    {
      label: "API Keys",
      value: activeKeys > 0 ? `${activeKeys} active` : "None",
      badge: (activeKeys > 0 ? "info" : "inactive") as BadgeVariant,
      detail: activeKeys > 0 ? "Developer access configured" : "No keys created yet",
    },
  ];

  const quickActions: Array<{ label: string; section: Section; icon: React.ElementType }> = [
    { label: "Edit Profile", section: "profile", icon: User },
    { label: "API Keys", section: "api-keys", icon: Key },
    { label: "Security", section: "security", icon: Shield },
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

function WorkspaceSection({ profile, setProfile, saveProfile, saveStatus, userSettings, saveSettings }: SharedProps) {
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
        <SettingRow label="Date format" description="Applies to exports and document metadata. Saved automatically.">
          <select
            className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400"
            value={userSettings.dateFormat}
            onChange={(e) => void saveSettings({ dateFormat: e.target.value })}
          >
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
          </select>
        </SettingRow>
        <SettingRow label="Default timezone" description="Used for scheduled jobs and audit timestamps.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">UTC</span>
            <StatusBadge label="Coming soon" variant="inactive" />
          </div>
        </SettingRow>
        <SettingRow label="Default OCR language" description="Primary language when processing documents. English is used by default." last>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">English</span>
            <StatusBadge label="Coming soon" variant="inactive" />
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
            <span className="text-sm text-slate-600">{profile.email || "—"}</span>
            {profile.email ? <StatusBadge label="Verified" variant="healthy" /> : null}
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
            <Toggle on={false} onChange={() => undefined} disabled />
            <StatusBadge label="Coming soon" variant="inactive" />
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

function SecuritySection({ email }: { email: string }) {
  const [resetState, setResetState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function sendPasswordReset() {
    if (!supabase || !email) {
      setResetState("error");
      return;
    }
    setResetState("sending");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${getSiteUrl()}/login?mode=signin`,
    });
    setResetState(error ? "error" : "sent");
  }

  return (
    <div className="space-y-8">
      <SectionHeader title="Security" description="Authentication methods, active sessions, and access controls." />

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Password</h3>
        <div className="rounded-xl border border-slate-100">
          <SettingRow label="Password" description="We'll email you a secure link to set a new password.">
            <div className="flex items-center gap-2">
              <ActionButton onClick={() => void sendPasswordReset()} disabled={resetState === "sending" || !email}>
                {resetState === "sending" ? "Sending…" : resetState === "sent" ? "Email sent ✓" : "Change password"}
              </ActionButton>
            </div>
          </SettingRow>
          <SettingRow label="Recovery codes" description="Emergency codes if you lose access to your 2FA device." last>
            <StatusBadge label="Coming soon" variant="inactive" />
          </SettingRow>
        </div>
        {resetState === "sent" && <p className="mt-2 text-sm font-semibold text-emerald-600">Password reset link sent to {email}.</p>}
        {resetState === "error" && <p className="mt-2 text-sm font-semibold text-rose-600">Could not send reset email. Please try again.</p>}
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
                <p className="mt-0.5 text-sm text-amber-700">Authenticator-app 2FA is coming soon. For now, keep your account secure with a strong, unique password.</p>
              </div>
            </div>
            <StatusBadge label="Coming soon" variant="inactive" />
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Active Sessions</h3>
        <div className="rounded-xl border border-slate-100 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-800">Session management</p>
              <p className="mt-0.5 text-sm text-slate-500">Signing out clears your session on this device. Per-device session revocation is coming soon.</p>
            </div>
            <StatusBadge label="Coming soon" variant="inactive" />
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

// ─── Companies ────────────────────────────────────────────────────────────────

function CompaniesSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="Company Profiles" description="Manage the businesses you invoice from — logo, banking details, and invoice defaults." />
      <div className="rounded-xl border border-slate-100 p-6 text-center">
        <Building2 className="mx-auto mb-3 h-8 w-8 text-slate-300" />
        <p className="text-sm font-semibold text-slate-700">Manage your company profiles</p>
        <p className="mt-1 text-sm text-slate-500">
          Add multiple businesses, set banking details once, and choose a default company profile used when creating invoices.
        </p>
        <div className="mt-5">
          <Link
            href="/settings/companies"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            Open Company Profiles <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Storage ──────────────────────────────────────────────────────────────────

function formatStorageBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index <= 1 ? 0 : 1)} ${units[index]}`;
}

function StorageSection({
  usage,
  usageState,
  loadUsage,
}: {
  usage: UsageState;
  usageState: "loading" | "ready" | "error";
  loadUsage: () => Promise<void>;
}) {
  const stats: Array<{ label: string; value: string }> = [
    { label: "Storage used", value: usage ? formatStorageBytes(usage.storageBytes) : "—" },
    { label: "Documents", value: usage ? usage.documentsUploaded.toLocaleString() : "—" },
    { label: "Pages processed", value: usage ? usage.pagesProcessed.toLocaleString() : "—" },
  ];
  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader title="Storage" description="Storage usage across this workspace." />
        <button
          type="button"
          onClick={() => void loadUsage()}
          disabled={usageState === "loading"}
          className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {usageState === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {usageState === "error" ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          Unable to load storage usage.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{stat.label}</p>
              <p className="mt-2 text-2xl font-bold text-navy-950">{usageState === "loading" ? "…" : stat.value}</p>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="Retention policy" description="Automatically archive or delete documents after a set period.">
          <StatusBadge label="Coming soon" variant="inactive" />
        </SettingRow>
        <SettingRow label="Version history" description="Version history is retained automatically for processed documents." last>
          <StatusBadge label="Automatic" variant="healthy" />
        </SettingRow>
      </div>
    </div>
  );
}

// ─── OCR & Processing ─────────────────────────────────────────────────────────

function OcrAiSection() {
  return (
    <div className="space-y-8">
      <SectionHeader title="OCR & Processing" description="Configure OCR, document processing and extraction readiness." />
      <div className="rounded-xl border border-slate-100">
        <SettingRow label="OCR engine" description="OCR runs on the conversion worker (ocrmypdf / Tesseract). Provider keys are managed server-side.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Conversion worker</span>
            <StatusBadge label="Server-managed" variant="info" />
          </div>
        </SettingRow>
        <SettingRow label="Document intelligence provider" description="AI summaries and extraction use the server's configured provider (requires OPENAI_API_KEY on the worker).">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">OpenAI</span>
            <StatusBadge label="Server-managed" variant="info" />
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
          <Link href="/settings/integrations" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700">
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
  keyName,
  setKeyName,
  keyBusy,
  revokeBusyId,
}: {
  apiKeys: ApiKey[];
  newSecret: string;
  createApiKey: () => Promise<void>;
  revokeApiKey: (id: string, revoked: boolean) => Promise<void>;
  keyName: string;
  setKeyName: (value: string) => void;
  keyBusy: boolean;
  revokeBusyId: string | null;
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-800">API Keys</p>
          <p className="text-sm text-slate-500">
            {apiKeys.filter((k) => !k.revokedAt && !k.revoked_at).length} active ·{" "}
            {apiKeys.filter((k) => k.revokedAt || k.revoked_at).length} revoked
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="min-h-10 w-48 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            placeholder="Key name (optional)"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
          />
          <ActionButton variant="primary" onClick={createApiKey} disabled={keyBusy}>
            <Plus className="h-4 w-4" />
            {keyBusy ? "Creating…" : "Create key"}
          </ActionButton>
        </div>
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
                <ActionButton
                  variant={revoked ? "secondary" : "danger"}
                  onClick={() => void revokeApiKey(key.id, !revoked)}
                  disabled={revokeBusyId === key.id}
                >
                  {revokeBusyId === key.id ? "…" : revoked ? "Restore" : "Revoke"}
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
        <div className="mt-5 flex items-center gap-3">
          <ActionButton variant="primary" disabled>
            <CreditCard className="h-4 w-4" />
            Upgrade plan
          </ActionButton>
          <span className="text-xs font-semibold text-slate-400">Available once Stripe billing is connected.</span>
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
            <div className="flex flex-col items-end gap-1">
              <ActionButton variant="secondary" disabled>Export</ActionButton>
              <StatusBadge label="Coming soon" variant="inactive" />
            </div>
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
              <p className="mt-2 text-xs font-semibold text-rose-600">
                To prevent accidental data loss, workspace deletion is handled by support. Contact support to permanently delete this workspace.
              </p>
            </div>
            <ActionButton variant="danger" disabled>
              <Trash2 className="h-4 w-4" />
              Delete
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}

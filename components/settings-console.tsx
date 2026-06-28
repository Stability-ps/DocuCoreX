"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, KeyRound, Plus, ShieldCheck, Smartphone, X, ArrowRight } from "lucide-react";
import { SectionPanel } from "@/components/ui";
import type { UserSettingsRecord } from "@/lib/app-state";
import { settingsGroups } from "@/lib/product-data";

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

export function SettingsConsole() {
  const [profile, setProfile] = useState({ fullName: "Patric", company: "DocuCoreX Workspace", role: "Owner" });
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [newSecret, setNewSecret] = useState("");
  const [status, setStatus] = useState("Ready");
  const [activeSection, setActiveSection] = useState("Profile");
  const [openModal, setOpenModal] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettingsRecord>({
    theme: "system",
    notifications: true,
    dateFormat: "DD/MM/YYYY",
    defaultExport: "xlsx",
    viewerDensity: "comfortable",
  });

  useEffect(() => {
    async function load() {
      const [profileResponse, keysResponse, auditResponse, userSettingsResponse] = await Promise.all([
        fetch("/api/profile"),
        fetch("/api/api-keys"),
        fetch("/api/audit-logs"),
        fetch("/api/user-settings"),
      ]);

      if (profileResponse.ok) {
        const data = (await profileResponse.json()) as ProfilePayload;
        setProfile({
          fullName: data.profile.fullName ?? data.profile.full_name ?? "Patric",
          company: data.profile.company ?? "DocuCoreX Workspace",
          role: data.profile.role ?? "Owner",
        });
      }

      if (keysResponse.ok) {
        const data = (await keysResponse.json()) as { apiKeys: ApiKey[] };
        setApiKeys(data.apiKeys);
      }

      if (auditResponse.ok) {
        const data = (await auditResponse.json()) as { auditLogs: AuditLog[] };
        setAuditLogs(data.auditLogs);
      }

      if (userSettingsResponse.ok) {
        const data = (await userSettingsResponse.json()) as { settings: UserSettingsRecord };
        setUserSettings(data.settings);
      }
    }

    void load();
  }, []);

  async function saveProfile() {
    setStatus("Saving profile…");
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    if (response.ok) {
      setStatus("Profile saved successfully");
      setTimeout(() => setStatus("Ready"), 2000);
    } else {
      setStatus("Profile save failed");
    }
  }

  async function createApiKey() {
    setStatus("Creating API key…");
    const response = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace automation key" }),
    });

    if (!response.ok) {
      setStatus("API key creation failed");
      return;
    }

    const data = (await response.json()) as { apiKey: ApiKey; secret: string };
    setApiKeys((current) => [data.apiKey, ...current]);
    setNewSecret(data.secret);
    setStatus("API key created");
  }

  async function revokeApiKey(id: string, revoked: boolean) {
    const response = await fetch("/api/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, revoked }),
    });
    if (!response.ok) {
      setStatus("API key update failed");
      return;
    }
    const data = (await response.json()) as { apiKey: ApiKey };
    setApiKeys((current) => current.map((apiKey) => (apiKey.id === id ? data.apiKey : apiKey)));
    setStatus(revoked ? "API key revoked" : "API key restored");
  }

  async function saveUserSettings(patch: Partial<UserSettingsRecord>) {
    const next = { ...userSettings, ...patch };
    setUserSettings(next);
    const response = await fetch("/api/user-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    setStatus(response.ok ? "Settings saved" : "Settings save failed");
  }

  function applyTheme(theme: UserSettingsRecord["theme"]) {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.body.classList.add("bg-slate-950");
    } else {
      document.documentElement.classList.remove("dark");
      document.body.classList.remove("bg-slate-950");
    }
  }

  async function updateTheme(theme: UserSettingsRecord["theme"]) {
    applyTheme(theme);
    await saveUserSettings({ theme });
  }

  const securityItems = useMemo(
    () => [
      ["Email verification", "Required for new workspaces", CheckCircle2],
      ["Two-factor authentication", "Future-ready enrollment state", Smartphone],
      ["Session protection", "Secure device and browser sessions", ShieldCheck],
      ["Password recovery", "Recovery links and reset controls", KeyRound],
    ],
    [],
  );

  const sectionToModal: Record<string, string> = {
    Theme: "theme",
    Notifications: "notifications",
    "API Keys": "api-keys",
    Security: "security",
    Billing: "billing",
    Storage: "storage",
    "Connected Apps": "connected-apps",
    Profile: "profile",
    Access: "access",
    Search: "search",
    Downloads: "downloads",
    Viewer: "viewer",
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {settingsGroups.map((group) => (
          <button
            key={group.title}
            type="button"
            onClick={() => setOpenModal(sectionToModal[group.title] ?? group.title.toLowerCase())}
            className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-royal-300 hover:bg-royal-50 hover:shadow-soft"
          >
            <group.icon className="h-6 w-6 text-royal-600" />
            <h2 className="mt-4 text-lg font-black text-navy-950">{group.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{group.detail}</p>
          </button>
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
      <SectionPanel title="Preferences" description={`Active section: ${activeSection}. ${status}`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Theme</span>
            <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(event) => updateTheme(event.target.value as UserSettingsRecord["theme"])} value={userSettings.theme}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Default export</span>
            <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(event) => saveUserSettings({ defaultExport: event.target.value as UserSettingsRecord["defaultExport"] })} value={userSettings.defaultExport}>
              <option value="xlsx">Excel</option>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <label className="flex items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm font-black text-slate-700">
            <input type="checkbox" checked={userSettings.notifications} onChange={(event) => saveUserSettings({ notifications: event.target.checked })} className="h-4 w-4 accent-royal-600" />
            Processing notifications
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Viewer density</span>
            <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(event) => saveUserSettings({ viewerDensity: event.target.value as UserSettingsRecord["viewerDensity"] })} value={userSettings.viewerDensity}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </div>
      </SectionPanel>

      <SectionPanel title="Security Readiness" description="Professional authentication settings for the next Supabase integration step.">
        <div className="space-y-3">
          {securityItems.map(([title, body, Icon]) => (
            <div key={title as string} className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <Icon className="h-5 w-5 text-royal-600" />
              <div>
                <p className="font-black text-navy-950">{title as string}</p>
                <p className="text-sm text-slate-500">{body as string}</p>
              </div>
              <span className="ml-auto rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">Ready</span>
            </div>
          ))}
        </div>
      </SectionPanel>

      <SectionPanel title="Profile Settings" description={`Account identity and workspace profile. ${status}`}>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Full name</span>
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
              onChange={(event) => setProfile((current) => ({ ...current, fullName: event.target.value }))}
              value={profile.fullName}
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Company</span>
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
              onChange={(event) => setProfile((current) => ({ ...current, company: event.target.value }))}
              value={profile.company}
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-black text-slate-700">Role</span>
            <input
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white"
              onChange={(event) => setProfile((current) => ({ ...current, role: event.target.value }))}
              value={profile.role}
            />
          </label>
          <button onClick={saveProfile} className="w-full rounded-2xl bg-royal-600 px-5 py-3 text-sm font-black text-white shadow-glow">
            Save Profile
          </button>
        </div>
      </SectionPanel>

      <SectionPanel title="API Keys" description="Create keys for automation, ingestion and developer workflows. Secrets are shown once.">
        <div className="space-y-3">
          <button onClick={createApiKey} className="inline-flex items-center gap-2 rounded-full bg-navy-950 px-4 py-2.5 text-sm font-black text-white">
            <Plus className="h-4 w-4" />
            Create API Key
          </button>
          {newSecret ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-700">Copy now</p>
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-white px-3 py-2 font-mono text-xs text-navy-950">
                <span className="min-w-0 flex-1 truncate">{newSecret}</span>
                <Copy className="h-4 w-4 text-slate-400" />
              </div>
            </div>
          ) : null}
          {apiKeys.map((apiKey) => (
            <div key={apiKey.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-black text-navy-950">{apiKey.name}</p>
                  <p className="text-sm text-slate-500">
                    Ends in {apiKey.lastFour ?? apiKey.last_four ?? "----"} • {apiKey.revokedAt || apiKey.revoked_at ? "Revoked" : "Active"}
                  </p>
                </div>
                <button
                  onClick={() => revokeApiKey(apiKey.id, !(apiKey.revokedAt || apiKey.revoked_at))}
                  className="rounded-xl bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm hover:text-royal-700"
                >
                  {apiKey.revokedAt || apiKey.revoked_at ? "Restore" : "Revoke"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </SectionPanel>

      <SectionPanel title="Audit Logs" description="Security and processing events for compliance review.">
        <div className="space-y-3">
          {auditLogs.map((log) => (
            <div key={log.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="font-black text-navy-950">{log.action}</p>
              <p className="text-sm text-slate-500">
                {log.actor ?? "System"} • {log.entityType ?? log.entity_type ?? "entity"}
              </p>
            </div>
          ))}
        </div>
      </SectionPanel>
      </div>

      {/* Modal Overlay */}
      {openModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
              <h2 className="text-lg font-black text-navy-950">{getModalTitle(openModal)}</h2>
              <button
                onClick={() => setOpenModal(null)}
                className="rounded-lg p-1 hover:bg-slate-100"
              >
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <div className="p-6">
              <ModalContent
                modalType={openModal}
                profile={profile}
                setProfile={setProfile}
                saveProfile={saveProfile}
                userSettings={userSettings}
                saveUserSettings={saveUserSettings}
                updateTheme={updateTheme}
                apiKeys={apiKeys}
                newSecret={newSecret}
                createApiKey={createApiKey}
                revokeApiKey={revokeApiKey}
                auditLogs={auditLogs}
                status={status}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsSection({ activeSection, onOpenModal }: { activeSection: string; onOpenModal: (modal: string) => void }) {
  if (activeSection === "Connected Apps") {
    return <ModalAction label="Open integrations" detail="Manage accounting, storage and webhook connections." onClick={() => onOpenModal("connected-apps")} />;
  }

  if (activeSection === "Access") {
    return <ModalAction label="Open team access" detail="Invite users and review roles." onClick={() => onOpenModal("access")} />;
  }

  if (activeSection === "Billing") {
    return <DisabledAction label="Stripe billing is not configured yet" detail="Add Stripe keys before enabling subscription management." />;
  }

  if (activeSection === "Storage") {
    return <DisabledAction label="Storage usage loads from uploaded documents" detail="No storage management action is needed until plan limits are configured." />;
  }

  if (activeSection === "Security") {
    return <ModalAction label="Open auth diagnostics" detail="Review session, profile, workspace and cookie status." onClick={() => onOpenModal("security")} />;
  }

  if (["Search", "Downloads", "Viewer"].includes(activeSection)) {
    return <DisabledAction label={`${activeSection} advanced controls coming soon`} detail="Current defaults are active; provider-specific controls are not enabled yet." />;
  }

  return <DisabledAction label={`${activeSection} settings are available below`} detail="Use the editable controls on this page to save changes." />;
}

function ModalAction({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex flex-col items-start rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow transition hover:bg-royal-700 active:scale-95"
    >
      <span className="flex items-center gap-2">
        {label} <ArrowRight className="h-4 w-4" />
      </span>
      <span className="mt-1 text-xs font-bold text-blue-100">{detail}</span>
    </button>
  );
}

function ActionLink({ href, label, detail }: { href: string; label: string; detail: string }) {
  return (
    <Link href={href} className="inline-flex flex-col rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">
      <span>{label}</span>
      <span className="mt-1 text-xs font-bold text-blue-100">{detail}</span>
    </Link>
  );
}

function DisabledAction({ label, detail }: { label: string; detail: string }) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title={label}
      className="rounded-2xl border border-slate-200 bg-slate-100 px-4 py-3 text-left text-sm font-black text-slate-500"
    >
      <span className="block">{label}</span>
      <span className="mt-1 block text-xs font-bold">{detail}</span>
    </button>
  );
}

function getModalTitle(modalType: string): string {
  const titles: Record<string, string> = {
    theme: "Theme",
    notifications: "Notifications",
    "api-keys": "API Keys",
    security: "Security",
    billing: "Billing",
    storage: "Storage",
    "connected-apps": "Connected Apps & Integrations",
    profile: "Profile",
    access: "Team Access & Permissions",
    search: "Search Settings",
    downloads: "Download Settings",
    viewer: "Viewer Settings",
  };
  return titles[modalType] ?? "Settings";
}

type ModalContentProps = {
  modalType: string;
  profile: { fullName: string; company: string; role: string };
  setProfile: React.Dispatch<React.SetStateAction<{ fullName: string; company: string; role: string }>>;
  saveProfile: () => Promise<void>;
  userSettings: UserSettingsRecord;
  saveUserSettings: (patch: Partial<UserSettingsRecord>) => Promise<void>;
  updateTheme: (theme: UserSettingsRecord["theme"]) => Promise<void>;
  apiKeys: ApiKey[];
  newSecret: string;
  createApiKey: () => Promise<void>;
  revokeApiKey: (id: string, revoked: boolean) => Promise<void>;
  auditLogs: AuditLog[];
  status: string;
};

function ModalContent({ modalType, profile, setProfile, saveProfile, userSettings, saveUserSettings, updateTheme, apiKeys, newSecret, createApiKey, revokeApiKey, auditLogs, status }: ModalContentProps) {
  if (modalType === "theme") {
    return (
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Theme</span>
          <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(e) => updateTheme(e.target.value as UserSettingsRecord["theme"])} value={userSettings.theme}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">Changes are saved automatically.</p>
      </div>
    );
  }

  if (modalType === "notifications") {
    return (
      <div className="space-y-3">
        <label className="flex items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm font-black text-slate-700">
          <input type="checkbox" checked={userSettings.notifications} onChange={(e) => saveUserSettings({ notifications: e.target.checked })} className="h-4 w-4 accent-royal-600" />
          Processing notifications
        </label>
        <p className="text-xs text-slate-500">Email alerts when documents finish processing, are shared, or have billing events.</p>
      </div>
    );
  }

  if (modalType === "api-keys") {
    return (
      <div className="space-y-3">
        <button onClick={createApiKey} className="inline-flex items-center gap-2 rounded-full bg-navy-950 px-4 py-2.5 text-sm font-black text-white">
          <Plus className="h-4 w-4" />
          Create API Key
        </button>
        {newSecret ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-700">Copy now — shown once</p>
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-white px-3 py-2 font-mono text-xs text-navy-950">
              <span className="min-w-0 flex-1 truncate">{newSecret}</span>
              <Copy className="h-4 w-4 text-slate-400" />
            </div>
          </div>
        ) : null}
        {apiKeys.length === 0 && !newSecret && <p className="text-sm text-slate-500">No API keys yet.</p>}
        {apiKeys.map((key) => (
          <div key={key.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-black text-navy-950">{key.name}</p>
                <p className="text-sm text-slate-500">Ends in {key.lastFour ?? key.last_four ?? "----"} • {key.revokedAt || key.revoked_at ? "Revoked" : "Active"}</p>
              </div>
              <button onClick={() => revokeApiKey(key.id, !(key.revokedAt || key.revoked_at))} className="rounded-xl bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm hover:text-royal-700">
                {key.revokedAt || key.revoked_at ? "Restore" : "Revoke"}
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (modalType === "security") {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl bg-slate-50 p-4 space-y-3">
          {[["Email verification", "Required for new workspaces"], ["Session protection", "Secure device and browser sessions"], ["Two-factor authentication", "Future-ready enrollment"], ["Password recovery", "Recovery links and reset controls"]].map(([title, body]) => (
            <div key={title} className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-black text-navy-950">{title}</p>
                <p className="text-xs text-slate-500">{body}</p>
              </div>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">Ready</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (modalType === "billing") {
    return (
      <div className="space-y-3">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="font-black text-amber-800">Stripe billing not configured</p>
          <p className="mt-1 text-sm text-amber-700">Add Stripe keys in your Vercel environment variables before enabling subscription management.</p>
        </div>
      </div>
    );
  }

  if (modalType === "storage") {
    return (
      <div className="space-y-3">
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="font-black text-navy-950">Storage usage</p>
          <p className="mt-1 text-sm text-slate-500">Storage limits and retention rules will be available once plan configuration is set up. Your documents are stored securely in Supabase Storage.</p>
        </div>
      </div>
    );
  }

  if (modalType === "connected-apps") {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">Manage integrations with accounting platforms, storage providers, and webhook connections.</p>
        <Link href="/integrations" className="inline-flex items-center gap-2 rounded-2xl bg-royal-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-royal-700">
          Go to Integrations <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  if (modalType === "profile") {
    return (
      <div className="space-y-4">
        <p className="text-xs text-slate-500">{status}</p>
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Full name</span>
          <input className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white" onChange={(e) => setProfile((c) => ({ ...c, fullName: e.target.value }))} value={profile.fullName} />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Company</span>
          <input className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white" onChange={(e) => setProfile((c) => ({ ...c, company: e.target.value }))} value={profile.company} />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Role</span>
          <input className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-royal-300 focus:bg-white" onChange={(e) => setProfile((c) => ({ ...c, role: e.target.value }))} value={profile.role} />
        </label>
        <button onClick={saveProfile} className="w-full rounded-2xl bg-royal-600 px-5 py-3 text-sm font-black text-white shadow-glow">Save Profile</button>
      </div>
    );
  }

  if (modalType === "access") {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600">Invite team members and manage their roles and permissions within your workspace.</p>
        <Link href="/team" className="inline-flex items-center gap-2 rounded-2xl bg-royal-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-royal-700">
          Go to Team Settings <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  if (modalType === "downloads") {
    return (
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Default export format</span>
          <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(e) => saveUserSettings({ defaultExport: e.target.value as UserSettingsRecord["defaultExport"] })} value={userSettings.defaultExport}>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">Changes are saved automatically.</p>
      </div>
    );
  }

  if (modalType === "viewer") {
    return (
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-black text-slate-700">Viewer density</span>
          <select className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black outline-none" onChange={(e) => saveUserSettings({ viewerDensity: e.target.value as UserSettingsRecord["viewerDensity"] })} value={userSettings.viewerDensity}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">Controls spacing in the document viewer. Changes are saved automatically.</p>
      </div>
    );
  }

  // Search — coming soon
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <p className="font-black text-navy-950">Coming soon</p>
      <p className="mt-1 text-sm text-slate-500">Advanced controls for this section are not yet available. Current defaults are active.</p>
    </div>
  );
}

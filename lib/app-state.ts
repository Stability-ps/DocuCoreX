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

type AppStore = {
  teamMembers: TeamMemberRecord[];
  integrations: IntegrationRecord[];
  automationPipelines: AutomationPipelineRecord[];
  supportRequests: SupportRequestRecord[];
  userSettings: UserSettingsRecord;
};

const now = new Date().toISOString();
const globalStore = globalThis as typeof globalThis & { __docucorexAppStore?: AppStore };

export const appStore =
  globalStore.__docucorexAppStore ??
  (globalStore.__docucorexAppStore = {
    teamMembers: [
      { id: "patric", name: "Patric", email: "patric@docucorex.local", role: "Owner", status: "Active" },
      { id: "finance", name: "Finance Team", email: "finance@docucorex.local", role: "Finance", status: "Active" },
    ],
    integrations: [
      { id: "quickbooks", name: "QuickBooks Online", category: "Accounting", status: "ready_to_connect", config: {}, updatedAt: now },
      { id: "google-sheets", name: "Google Sheets", category: "Export", status: "ready_to_connect", config: {}, updatedAt: now },
      { id: "google-drive", name: "Google Drive", category: "Cloud storage", status: "ready_to_connect", config: {}, updatedAt: now },
      { id: "onedrive", name: "OneDrive", category: "Cloud storage", status: "ready_to_connect", config: {}, updatedAt: now },
      { id: "dropbox", name: "Dropbox", category: "Cloud storage", status: "ready_to_connect", config: {}, updatedAt: now },
      { id: "webhooks", name: "Webhooks", category: "Developer", status: "connected", config: { endpoint: "/api/webhooks/documents" }, updatedAt: now },
    ],
    automationPipelines: [
      { id: "pipeline_finance", name: "Finance uploads to Excel", input: "Finance uploads folder", output: "Excel export queue", active: true, createdAt: now },
    ],
    supportRequests: [],
    userSettings: {
      theme: "system",
      notifications: true,
      dateFormat: "DD/MM/YYYY",
      defaultExport: "xlsx",
      viewerDensity: "comfortable",
    },
  });

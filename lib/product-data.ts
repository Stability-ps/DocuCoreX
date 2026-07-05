import {
  Activity,
  Archive,
  BadgeCheck,
  Bell,
  BookOpen,
  BookOpenText,
  Bot,
  CloudUpload,
  Code2,
  Columns3,
  CreditCard,
  Download,
  Edit3,
  Eye,
  FileArchive,
  FileClock,
  FileCog,
  FileImage,
  FileInput,
  FileSearch,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderArchive,
  FolderPlus,
  Gauge,
  GitBranch,
  History,
  PlugZap,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  MessageSquareText,
  Palette,
  PencilLine,
  ReceiptText,
  RefreshCcw,
  ScanText,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Star,
  Tags,
  Trash2,
  WandSparkles,
  Upload,
  UsersRound,
  Workflow,
  Globe,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

export type NavGroup = NavItem & {
  children?: NavItem[];
};

export const appNav: NavGroup[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    title: "Documents",
    href: "/documents",
    icon: Folder,
    children: [
      { title: "Intake", href: "/intake", icon: FileInput },
      { title: "Upload Center", href: "/upload", icon: Upload },
      { title: "All Documents", href: "/documents", icon: Folder },
      { title: "Recent", href: "/documents/recent", icon: FileClock },
      { title: "Shared", href: "/documents/shared", icon: Share2 },
      { title: "Archive", href: "/documents/archive", icon: FolderArchive },
      { title: "Trash", href: "/documents/trash", icon: Trash2 },
    ],
  },
  {
    title: "Convert Files",
    href: "/upload",
    icon: RefreshCcw,
    children: [
      { title: "OCR", href: "/convert/ocr", icon: ScanText },
      { title: "Extraction", href: "/convert/extraction", icon: FileSearch },
      { title: "Summaries", href: "/convert/summaries", icon: WandSparkles },
      { title: "Compare", href: "/convert/compare", icon: Columns3 },
      { title: "Translate", href: "/convert/translate", icon: MessageSquareText },
      { title: "Redact", href: "/convert/redact", icon: PencilLine },
    ],
  },
  { title: "Accounting Intelligence", href: "/accounting", icon: ReceiptText },
  { title: "Invoices", href: "/invoices", icon: FileText },
  { title: "Billing & Subscription", href: "/billing", icon: CreditCard },
  { title: "Team & Collaboration", href: "/team", icon: UsersRound },
  { title: "Help & Support", href: "/help", icon: BookOpen },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
  },
];

export const newActionItems: NavItem[] = [
  { title: "Upload Document", href: "/upload", icon: CloudUpload },
  { title: "FNB Statement", href: "/accounting", icon: ReceiptText },
  { title: "Scan Document", href: "/upload?workflow=scan_document", icon: ScanText },
  { title: "Create Folder", href: "/documents/folders", icon: FolderPlus },
  { title: "Import Files", href: "/upload?workflow=import_files", icon: FileInput },
  { title: "New Automation", href: "/settings/automations", icon: Workflow },
  { title: "New API Key", href: "/settings/api-keys", icon: KeyRound },
];

export const dashboardStats = [
  { label: "Documents Uploaded", value: "1,284", detail: "+142 this month", icon: FileText, tone: "blue" },
  { label: "Pages Processed", value: "48,930", detail: "7,420 queued", icon: BookOpenText, tone: "navy" },
  { label: "OCR Credits Remaining", value: "86,400", detail: "Enterprise pool", icon: ScanText, tone: "green" },
  { label: "Storage Used", value: "2.8 TB", detail: "72% of plan", icon: CloudUpload, tone: "amber" },
  { label: "Exports", value: "9,718", detail: "Excel, CSV, JSON", icon: Download, tone: "purple" },
  { label: "Recent Activity", value: "312", detail: "Last 24 hours", icon: Activity, tone: "rose" },
];

export const quickActions = [
  { label: "Upload Document", href: "/upload", icon: CloudUpload, description: "PDF, Office, images and ZIP" },
  { label: "Convert File", href: "/upload", icon: RefreshCcw, description: "PDF, Word, Excel and images" },
  { label: "Edit PDF", href: "/documents", icon: Edit3, description: "Open a document workspace" },
  { label: "OCR Scan", href: "/convert/ocr", icon: ScanText, description: "Extract text and layout" },
  { label: "AI Analysis", href: "/convert/summaries", icon: Bot, description: "Ask document questions" },
];

export const recentActivity = [
  { title: "FNB supplier statement extracted", meta: "2,418 rows • 98.7% confidence", time: "2 min ago", icon: BadgeCheck },
  { title: "Invoice batch converted to Excel", meta: "46 files • XLSX ready", time: "18 min ago", icon: FileSpreadsheet },
  { title: "VAT receipts tagged for review", meta: "12 exceptions detected", time: "43 min ago", icon: Tags },
  { title: "Audit pack shared with Finance", meta: "3 recipients • view only", time: "1 hr ago", icon: Share2 },
];

export const uploadTypes = [
  { label: "PDF", icon: FileText },
  { label: "Word", icon: FileInput },
  { label: "Excel", icon: FileSpreadsheet },
  { label: "Images", icon: FileImage },
  { label: "ZIP", icon: FileArchive },
];

export const workspaceTabs = [
  "Overview",
  "Preview",
  "OCR",
  "Extracted Data",
  "AI Analysis",
  "History",
  "Comments",
  "Downloads",
];

export const extractionModules = [
  { title: "Bank Statements", confidence: 98, fields: "Date, description, money in, money out, balance", icon: FileSpreadsheet },
  { title: "Invoices", confidence: 96, fields: "Supplier, VAT, totals, line items, due date", icon: ReceiptText },
  { title: "Receipts", confidence: 94, fields: "Merchant, tax, payment method, totals", icon: FileSearch },
  { title: "Financial Statements", confidence: 92, fields: "Balance sheet, cash flow, income statement", icon: Gauge },
  { title: "Contracts", confidence: 89, fields: "Parties, dates, terms, obligations", icon: FileCog },
  { title: "Payslips", confidence: 97, fields: "Employee, gross pay, deductions, net pay", icon: UsersRound },
  { title: "Tax Documents", confidence: 95, fields: "Tax period, taxable amounts, references", icon: Archive },
  { title: "Purchase Orders", confidence: 93, fields: "PO number, supplier, item lines, approvals", icon: FileClock },
];

export const libraryFilters = [
  { label: "Recent", icon: FileClock },
  { label: "Shared", icon: Share2 },
  { label: "Starred", icon: Star },
  { label: "Trash", icon: Trash2 },
  { label: "Version History", icon: History },
];

export const documents = [
  {
    id: "statement-q2",
    name: "Business Statement Q2.pdf",
    type: "Bank statement",
    status: "Ready",
    size: "8.4 MB",
    pages: 42,
    owner: "Patric",
    updated: "Today, 08:42",
    tags: ["Finance", "Reconciliation", "VAT"],
  },
  {
    id: "invoice-batch",
    name: "Supplier Invoice Batch.zip",
    type: "Invoices",
    status: "Processing",
    size: "124 MB",
    pages: 318,
    owner: "Finance Team",
    updated: "Today, 07:18",
    tags: ["AP", "Suppliers"],
  },
  {
    id: "audit-pack",
    name: "FY2026 Audit Pack.pdf",
    type: "Financial statements",
    status: "Review",
    size: "36 MB",
    pages: 186,
    owner: "Audit",
    updated: "Yesterday",
    tags: ["Audit", "Board"],
  },
  {
    id: "receipts-june",
    name: "June Receipts",
    type: "Receipts",
    status: "OCR queued",
    size: "42 MB",
    pages: 96,
    owner: "Operations",
    updated: "Jun 25",
    tags: ["Expenses", "Mobile"],
  },
];

export const settingsGroups = [
  { title: "Theme", icon: Palette, detail: "Light, dark and system preferences" },
  { title: "Notifications", icon: Bell, detail: "Processing, sharing and billing alerts" },
  { title: "API Keys", icon: Code2, detail: "Developer keys and webhook secrets" },
  { title: "Security", icon: ShieldCheck, detail: "2FA, sessions, SSO and audit logs" },
  { title: "Billing", icon: CreditCard, detail: "Stripe subscription and invoices" },
  { title: "Storage", icon: CloudUpload, detail: "Usage limits, retention and vault rules" },
  { title: "Connected Apps", icon: Share2, detail: "Accounting, cloud storage and email" },
  { title: "Profile", icon: UsersRound, detail: "Name, company, role and avatar" },
  { title: "Access", icon: LockKeyhole, detail: "Roles, permissions and teams" },
  { title: "Search", icon: Search, detail: "Indexing, OCR languages and filters" },
  { title: "Downloads", icon: Download, detail: "Export defaults and secure links" },
  { title: "Viewer", icon: Eye, detail: "PDF preview and annotation preferences" },
];

export const conversionOptions = [
  "PDF → Word",
  "PDF → Excel",
  "PDF → Images",
  "Word → PDF",
  "Excel → PDF",
  "Images → PDF",
];

export const comments = [
  { name: "Mia", body: "Please verify the VAT treatment on the highlighted supplier payments.", time: "11:20" },
  { name: "Jon", body: "Duplicate transfer detected on page 14. Marked for reconciliation.", time: "10:48" },
  { name: "Lerato", body: "Exported clean CSV for the accounting import.", time: "09:31" },
];

export const historyEvents = [
  "Uploaded original document",
  "Virus scan completed",
  "OCR text layer generated",
  "Document type detected automatically",
  "Excel and JSON exports created",
];

export const ocrLines = [
  "Statement period: 01 Apr 2026 - 30 Jun 2026",
  "Opening balance: R 184,221.09",
  "Total money in: R 1,402,880.50",
  "Total money out: R 1,118,320.30",
  "Potential duplicate payments: 4",
  "VAT tagged transactions: 312",
];

export const profileChecklist = [
  "Email verification enabled",
  "Google sign-in available",
  "Microsoft sign-in available",
  "Two-factor authentication prepared",
  "Password recovery flow ready",
];

export const intakeTypes = [
  { title: "Bank & Credit Card Statements", workflow: "bank_statement", detail: "PDF statements, scanned statements and CSV transaction files", icon: FileSpreadsheet, target: "/upload?workflow=bank_statement" },
  { title: "Invoices & Receipts", workflow: "invoice_receipt", detail: "Supplier invoices, till slips, expense receipts and purchase orders", icon: ReceiptText, target: "/upload?workflow=invoice_receipt" },
  { title: "Tax Forms", workflow: "tax_document", detail: "VAT reports, certificates, tax schedules and compliance packs", icon: Archive, target: "/upload?workflow=tax_document" },
  { title: "Contracts", workflow: "contract", detail: "Agreements, leases, service contracts and signed PDFs", icon: FileCog, target: "/upload?workflow=contract" },
  { title: "Payslips", workflow: "payslip", detail: "Payroll records, deductions, benefits and net-pay summaries", icon: UsersRound, target: "/upload?workflow=payslip" },
  { title: "Other Documents", workflow: "unknown", detail: "Route unknown formats through custom OCR and AI extraction", icon: FileSearch, target: "/upload?workflow=unknown" },
];

export const integrationConnectors = [
  { name: "QuickBooks Online", category: "Accounting", status: "Ready to connect", detail: "Send invoices, receipts and reconciled transaction exports", icon: FileSpreadsheet },
  { name: "Google Sheets", category: "Export", status: "Ready to connect", detail: "Publish extracted rows and VAT summaries to spreadsheets", icon: FileSpreadsheet },
  { name: "Google Drive", category: "Cloud storage", status: "Ready to connect", detail: "Watch folders for incoming bank statements and invoices", icon: Folder },
  { name: "OneDrive", category: "Cloud storage", status: "Ready to connect", detail: "Auto-import documents from finance team folders", icon: CloudUpload },
  { name: "Dropbox", category: "Cloud storage", status: "Ready to connect", detail: "Sync processed files, exports and audit packs", icon: Archive },
  { name: "Webhooks", category: "Developer", status: "Configured locally", detail: "Notify external systems when OCR, extraction or export jobs complete", icon: Code2 },
];

export const automationSteps = [
  { title: "Input", detail: "Watch cloud folders, email inboxes, uploads or API submissions", icon: CloudUpload },
  { title: "DocuCoreX", detail: "Run OCR, layout analysis, document detection and extraction", icon: Bot },
  { title: "Output", detail: "Export to spreadsheets, accounting tools, webhooks or secure vault folders", icon: GitBranch },
];

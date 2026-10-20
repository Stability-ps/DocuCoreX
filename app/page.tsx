import Image from "next/image";
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  Bot,
  Check,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  LockKeyhole,
  ReceiptText,
  RefreshCcw,
  ScanText,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  Upload,
  type LucideIcon,
} from "lucide-react";

const navItems = [
  "Home",
  "Features",
  "Solutions",
  "Pricing",
  "Resources",
  "Blog",
  "Contact",
];

const recentUploads = [
  { name: "Business Bank Statement", type: "Bank PDF", status: "Extracting", pct: 84 },
  { name: "VAT invoices Q2", type: "Invoice Pack", status: "OCR Ready", pct: 100 },
  { name: "Supplier receipts", type: "Scans", status: "Review", pct: 68 },
];

const products = [
  {
    icon: FileSpreadsheet,
    title: "Document Extraction",
    body: "Bank statements, invoices, receipts, payslips, tax certificates, financial statements, contracts and purchase orders.",
    chips: ["Excel", "CSV", "JSON"],
  },
  {
    icon: ScanText,
    title: "OCR Workspace",
    body: "Extract searchable text from images, PDFs and scanned documents, then search it or export it.",
    chips: ["Scans", "Images", "Search", "Export"],
  },
  {
    icon: RefreshCcw,
    title: "File Converter",
    body: "Convert between PDF, Word, Excel, CSV, HTML, text and images, and turn PowerPoint files into PDF.",
    chips: ["PDF", "Word", "Excel", "Images"],
  },
];

const intelligence = [
  "Income",
  "Expenses",
  "VAT",
  "Transfers",
  "Duplicates",
  "Cash withdrawals",
  "Recurring payments",
  "Loans",
  "Interest",
  "Fees",
];

// What the statement engine does, rather than which institutions it knows.
// A roster of named banks reads as a boundary — a reader whose bank is absent
// concludes the product is not for them — and it dates the moment support
// widens. Each of these is something the pipeline demonstrably does.
const statementCapabilities = [
  "Digital PDF statements",
  "Scanned PDF statements",
  "Automatic bank detection",
  "Transaction table extraction",
  "Balance reconciliation",
  "Opening and closing balances",
  "Multi-page statements",
  "Exception review queue",
  "Excel and CSV export",
  "Duplicate detection",
];

const features: Array<{ title: string; icon: LucideIcon; body: string; comingSoon?: boolean }> = [
  {
    title: "Financial Intelligence",
    icon: Banknote,
    body: "Generate cash flow, VAT summaries, monthly reports, income analysis, expense categories and risk reports automatically.",
  },
  {
    title: "AI Document Assistant",
    icon: Bot,
    body: "Ask questions about your documents and get answers that cite the page they came from.",
    comingSoon: true,
  },
  {
    title: "Reconciliation",
    icon: BadgeCheck,
    body: "Reconcile bank statement lines against your ledger, with duplicate detection and a review queue for anything that does not match.",
  },
  {
    title: "Secure Vault",
    icon: LockKeyhole,
    body: "Tags, version history, sharing, activity history and encrypted document storage.",
  },
  {
    title: "Enterprise Security",
    icon: ShieldCheck,
    body: "Workspace isolation, role permissions, time-limited secure downloads and audit logs.",
  },
];

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-royal-200 bg-white/80 px-3 py-1 text-xs font-semibold text-navy-800 shadow-sm">
      {children}
    </span>
  );
}

export default function Home() {
  return (
    <main className="overflow-hidden">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/70 bg-white/82 backdrop-blur-2xl">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <a href="/" className="flex items-center gap-3" aria-label="DocuCoreX home">
            <Image
              src="/docucorex-logo.png"
              alt="DocuCoreX"
              width={250}
              height={78}
              priority
              className="h-12 w-auto object-contain"
            />
          </a>
          <nav className="hidden items-center gap-6 text-sm font-semibold text-slate-600 lg:flex">
            {navItems.map((item) => (
              <a key={item} href={`#${item.toLowerCase()}`} className="transition hover:text-royal-600">
                {item}
              </a>
            ))}
          </nav>
          <div className="hidden items-center gap-3 sm:flex">
            <a href="/login" className="text-sm font-semibold text-navy-800 transition hover:text-royal-600">
              Login
            </a>
            <a
              href="/login"
              className="rounded-full bg-navy-950 px-5 py-2.5 text-sm font-bold text-white shadow-soft transition hover:-translate-y-0.5 hover:bg-royal-700"
            >
              Get Started
            </a>
          </div>
          <a
            href="/login"
            className="inline-flex items-center justify-center rounded-full bg-royal-600 px-4 py-2 text-sm font-semibold text-white shadow-sm sm:hidden"
          >
            Start
          </a>
        </div>
      </header>

      <section id="home" className="relative pt-28 sm:pt-32">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 sm:px-6 lg:grid-cols-[0.93fr_1.07fr] lg:px-8 lg:pb-24">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-royal-200 bg-white/80 px-3 py-1.5 text-sm font-bold text-royal-700 shadow-sm">
              <Sparkles className="h-4 w-4" />
              Extract, reconcile and export with enterprise accuracy
            </div>
            <h1 className="text-balance text-4xl font-semibold leading-[1.04] tracking-normal text-navy-950 sm:text-5xl lg:text-6xl">
              Turn Documents Into Structured Data.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600 sm:text-xl">
              Upload PDFs, bank statements, invoices, receipts and scanned documents. Extract, edit, convert, analyse and export in seconds.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-royal-600 px-6 py-3.5 text-base font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-royal-700"
              >
                Start Free Trial
                <ArrowRight className="h-5 w-5" />
              </a>
              <a
                href="#demo"
                className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3.5 text-base font-bold text-navy-900 shadow-sm transition hover:-translate-y-0.5 hover:border-royal-200 hover:text-royal-700"
              >
                Watch Demo
                <ChevronRight className="h-5 w-5" />
              </a>
            </div>
            <div className="mt-9 grid max-w-xl grid-cols-3 gap-4">
              {["Scanned-PDF OCR", "Workspace-isolated data", "Automatic bank detection"].map((item) => (
                <div key={item} className="rounded-2xl border border-white bg-white/72 p-3 text-sm font-bold text-navy-800 shadow-sm">
                  <Check className="mb-2 h-4 w-4 text-emerald-500" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div id="demo" className="glass relative rounded-[2rem] p-3 shadow-sm">
            <div className="rounded-[1.55rem] bg-navy-950 p-4 text-white navy-grid sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Image src="/docucorex-mark.png" alt="" width={56} height={56} className="h-11 w-11 rounded-2xl bg-white object-contain p-1" />
                  <div>
                    <p className="text-sm font-bold text-white">DocuCoreX Command Center</p>
                    <p className="text-xs text-blue-100">Example workspace</p>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[1.03fr_0.97fr]">
                <div className="rounded-xl border border-white/10 bg-white/[0.08] p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-sm font-bold">Recent uploads</p>
                    <Upload className="h-4 w-4 text-sky-300" />
                  </div>
                  <div className="space-y-3">
                    {recentUploads.map((upload) => (
                      <div key={upload.name} className="rounded-2xl border border-white/10 bg-white/[0.09] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-white">{upload.name}</p>
                            <p className="text-xs text-blue-100">{upload.type}</p>
                          </div>
                          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-royal-700">
                            {upload.status}
                          </span>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full rounded-full bg-royal-400 progress-stripe" style={{ width: `${upload.pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4">
                  <div className="rounded-xl bg-white p-4 text-navy-950 shadow-soft">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-semibold">Transactions extracted</p>
                      <ReceiptText className="h-4 w-4 text-royal-600" />
                    </div>
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-4xl font-semibold">2,418</p>
                      </div>
                      <div className="flex h-16 items-end gap-1.5">
                        {[38, 52, 31, 68, 44, 77, 61].map((height, index) => (
                          <div key={index} className="w-3 rounded-full bg-royal-500" style={{ height: `${height}%` }} />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-xl border border-white/10 bg-white/[0.09] p-4">
                      <FileSpreadsheet className="mb-3 h-5 w-5 text-emerald-300" />
                      <p className="text-xs font-bold text-blue-100">Excel export</p>
                      <p className="mt-1 text-2xl font-semibold">Ready</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/[0.09] p-4">
                      <FileText className="mb-3 h-5 w-5 text-amber-200" />
                      <p className="text-xs font-bold text-blue-100">CSV export</p>
                      <p className="mt-1 text-2xl font-semibold">Ready</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.08] p-4">
                <div className="mb-4 flex items-center justify-between">
                  <p className="text-sm font-bold">Document preview</p>
                </div>
                <div className="rounded-2xl bg-white p-4 text-navy-950">
                  <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Invoice Preview</p>
                    <p className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">Layout preserved</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[1fr_0.7fr]">
                    <div className="space-y-2">
                      <div className="h-3 w-3/4 rounded-full bg-slate-200" />
                      <div className="h-3 w-2/3 rounded-full bg-slate-100" />
                      <div className="h-20 rounded-2xl border border-royal-100 bg-royal-50/70 p-3">
                        <div className="h-3 w-1/2 rounded-full bg-royal-300" />
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <div className="h-3 rounded-full bg-white" />
                          <div className="h-3 rounded-full bg-white" />
                          <div className="h-3 rounded-full bg-white" />
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-100 p-3">
                      <p className="text-xs font-bold text-slate-500">Selected field</p>
                      <p className="mt-1 text-lg font-semibold text-royal-700">R 42,780.00</p>
                      <div className="mt-3 h-2 rounded-full bg-amber-300" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="border-y border-royal-100 bg-white/72 py-14">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          {products.map((product) => (
            <article key={product.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-soft">
              <product.icon className="mb-5 h-7 w-7 text-royal-600" />
              <h2 className="text-xl font-semibold text-navy-950">{product.title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">{product.body}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {product.chips.map((chip) => (
                  <Pill key={chip}>{chip}</Pill>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="solutions" className="py-20 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-royal-600">Financial document intelligence</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal text-navy-950 sm:text-5xl">
                Built for accountants, auditors and finance teams.
              </h2>
              <p className="mt-5 text-lg leading-8 text-slate-600">
                DocuCoreX detects financial patterns, reconciles statements against your ledger, and turns messy statements into analysis-ready exports for reporting and accounting systems.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                {intelligence.map((item) => (
                  <Pill key={item}>{item}</Pill>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {features.map((feature) => (
                <article key={feature.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <feature.icon className="mb-4 h-6 w-6 text-royal-600" />
                  <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-navy-950">
                    {feature.title}
                    {feature.comingSoon ? <Pill>Coming soon</Pill> : null}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="pricing" className="border-t border-royal-100 bg-white/76 py-20 sm:py-24">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:px-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-royal-600">Bank statement engine</p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal text-navy-950 sm:text-5xl">
              Built for bank statements, wherever they come from.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Upload a statement and the bank, account and period are detected from the document itself. Formats vary by institution, so new layouts are added as they are seen.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {statementCapabilities.map((capability) => (
              <div key={capability} className="flex min-h-24 items-center justify-center rounded-xl border border-slate-200 bg-white p-4 text-center text-sm font-semibold text-navy-950 shadow-sm">
                {capability}
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer id="contact" className="bg-navy-950 px-4 py-10 text-white sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Image src="/docucorex-mark.png" alt="DocuCoreX" width={52} height={52} className="h-12 w-12 rounded-2xl bg-white object-contain p-1" />
            <div>
              <p className="font-semibold">DocuCoreX</p>
              <p className="text-sm text-blue-100">Extract. Reconcile. Export.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-bold text-blue-100">
            <a href="#features" className="hover:text-white">Features</a>
            <a href="#solutions" className="hover:text-white">Solutions</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="mailto:hello@docucorex.com" className="hover:text-white">hello@docucorex.com</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

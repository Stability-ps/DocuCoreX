"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpenText, Clock3, FileText, FolderOpen, Landmark, LoaderCircle, RefreshCcw, ScanText, TriangleAlert, Upload } from "lucide-react";
import type { DocumentRecord } from "@/lib/types";

type Usage = {
  documentsUploaded?: number;
  documents_uploaded?: number;
  pagesProcessed?: number;
  pages_processed?: number;
  ocrCreditsRemaining?: number;
  ocr_credits_remaining?: number;
};

type ProfileResponse = {
  profile?: {
    full_name?: string;
    fullName?: string;
  };
};

type Job = {
  id: string;
  type: string;
  status: string;
  progress: number;
  message: string;
};

type Shortcut = {
  id: string;
  title: string;
  href: string;
  icon: typeof Upload;
};

function firstName(fullName: string | undefined) {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0] || "";
}

function greetingForHour(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good Morning 👋";
  if (hour < 18) return "Good Afternoon 👋";
  return "Good Evening 👋";
}

function summaryMessage({ processing, review, ready }: { processing: number; review: number; ready: number }) {
  if (review > 0) return `${review} document${review === 1 ? "" : "s"} need your review`;
  if (processing > 0) return `${processing} document${processing === 1 ? "" : "s"} still processing`;
  if (ready > 0) return `${ready} document${ready === 1 ? "" : "s"} ready for download`;
  return "Everything is up to date";
}

function toRelativeTime(value: string) {
  const now = Date.now();
  const target = new Date(value).getTime();
  const diff = Math.max(0, now - target);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

function dashboardStatus(status: DocumentRecord["status"]) {
  if (status === "review") return { label: "Needs Review", tone: "bg-amber-50 text-amber-700" };
  if (status === "failed") return { label: "Failed", tone: "bg-rose-50 text-rose-700" };
  if (status === "processing" || status === "queued" || status === "uploaded") return { label: "Processing", tone: "bg-blue-50 text-blue-700" };
  return { label: "Completed", tone: "bg-emerald-50 text-emerald-700" };
}

function friendlyDocumentName(name: string) {
  const trimmed = name.trim();
  const extension = trimmed.includes(".") ? trimmed.split(".").pop() : "";
  const stem = extension ? trimmed.slice(0, -(extension.length + 1)) : trimmed;
  const hashLike = /^[a-f0-9]{24,}$/i.test(stem);
  if (!hashLike) return trimmed;
  return `Document${extension ? `.${extension}` : ""}`;
}

export function DashboardLive() {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const [profileName, setProfileName] = useState<string>("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);

  useEffect(() => {
    async function load() {
      setState("loading");
      const [profileResponse, usageResponse, jobsResponse, documentsResponse] = await Promise.allSettled([
        fetch("/api/profile"),
        fetch("/api/usage"),
        fetch("/api/jobs"),
        fetch("/api/documents"),
      ]);

      let hasData = false;

      if (profileResponse.status === "fulfilled" && profileResponse.value.ok) {
        const data = (await profileResponse.value.json().catch(() => ({}))) as ProfileResponse;
        setProfileName(data.profile?.full_name ?? data.profile?.fullName ?? "");
      }

      if (usageResponse.status === "fulfilled" && usageResponse.value.ok) {
        const data = (await usageResponse.value.json().catch(() => ({}))) as { usage?: Usage };
        setUsage(data.usage ?? null);
        hasData = Boolean(data.usage);
      }

      if (jobsResponse.status === "fulfilled" && jobsResponse.value.ok) {
        const data = (await jobsResponse.value.json().catch(() => ({}))) as { jobs?: Job[] };
        setJobs(data.jobs ?? []);
        hasData = true;
      }

      if (documentsResponse.status === "fulfilled" && documentsResponse.value.ok) {
        const data = (await documentsResponse.value.json().catch(() => ({}))) as { documents?: DocumentRecord[] };
        setDocuments(data.documents ?? []);
        hasData = true;
      }

      setState(hasData ? "loaded" : "failed");
    }

    void load();
  }, []);

  const documentCount = documents.length;
  const pages = usage?.pagesProcessed ?? usage?.pages_processed ?? 0;
  const credits = usage?.ocrCreditsRemaining ?? usage?.ocr_credits_remaining ?? 0;

  const processingCount = useMemo(() => {
    const docCount = documents.filter((document) => ["uploaded", "queued", "processing"].includes(document.status)).length;
    const jobCount = jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
    return Math.max(docCount, jobCount);
  }, [documents, jobs]);
  const reviewCount = useMemo(() => documents.filter((document) => document.status === "review").length, [documents]);
  const readyCount = useMemo(() => documents.filter((document) => document.status === "ready").length, [documents]);

  const recentDocuments = useMemo(
    () => [...documents].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6),
    [documents],
  );

  const shortcuts = useMemo<Shortcut[]>(() => {
    const items: Shortcut[] = [];

    if (processingCount > 0) {
      items.push({ id: "processing", title: "Continue Processing", href: "/documents", icon: LoaderCircle });
    }

    if (reviewCount > 0) {
      items.push({ id: "review", title: "Continue Review", href: "/documents", icon: TriangleAlert });
    }

    if (jobs.some((job) => job.type === "conversion" && ["queued", "running"].includes(job.status))) {
      items.push({ id: "conversion", title: "Continue Conversion", href: "/upload", icon: RefreshCcw });
    }

    if (recentDocuments[0]) {
      items.push({ id: "recent", title: "Open Recent Document", href: `/documents/${recentDocuments[0].id}`, icon: FolderOpen });
    }

    items.push({ id: "upload", title: "Resume Upload", href: "/upload", icon: Upload });

    return items.slice(0, 4);
  }, [jobs, processingCount, recentDocuments, reviewCount]);

  if (state === "loading") {
    return <DashboardSkeleton />;
  }

  if (state === "failed") {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
        <p className="text-sm font-semibold text-rose-700">Unable to load dashboard data right now.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        {firstName(profileName) ? (
          <>
            <p className="text-lg font-semibold text-navy-950">{greetingForHour()}</p>
            <h1 className="mt-1 text-3xl font-black tracking-tight text-navy-950">{firstName(profileName)}</h1>
          </>
        ) : (
          <p className="text-2xl font-black tracking-tight text-navy-950">Hello 👋</p>
        )}
        <p className="mt-2 text-sm font-semibold text-slate-500">{summaryMessage({ processing: processingCount, review: reviewCount, ready: readyCount })}</p>
        <Link
          href="/upload"
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 text-sm font-black text-white shadow-sm"
        >
          <Upload className="h-5 w-5" />
          Upload Document
        </Link>
      </section>

      <section className="grid grid-cols-3 gap-2">
        {[
          { title: "Upload", href: "/upload", icon: Upload },
          { title: "Documents", href: "/documents", icon: FolderOpen },
          { title: "Accounting", href: "/accounting", icon: Landmark },
        ].map((item) => (
          <Link key={item.title} href={item.href} className="flex min-h-14 items-center gap-2 rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-navy-950 shadow-sm ring-1 ring-slate-200">
            <item.icon className="h-4 w-4 text-royal-600" />
            <span className="truncate">{item.title}</span>
          </Link>
        ))}
      </section>

      <section className="grid grid-cols-3 gap-3">
        {[
          { label: "Documents", value: documentCount.toLocaleString(), icon: FileText },
          { label: "Pages", value: pages.toLocaleString(), icon: BookOpenText },
          { label: "Credits", value: credits.toLocaleString(), icon: ScanText },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[11px] font-black uppercase tracking-[0.08em]">{card.label}</span>
              <card.icon className="h-4 w-4" />
            </div>
            <p className="mt-2 truncate text-2xl font-black tracking-tight text-navy-950">{card.value}</p>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-black uppercase tracking-[0.08em] text-slate-500">Recent Work</h2>
          <Link href="/documents" className="text-xs font-semibold text-royal-700">
            View all
          </Link>
        </div>
        <div className="space-y-2">
          {recentDocuments.length ? (
            recentDocuments.map((document) => {
              const status = dashboardStatus(document.status);
              return (
                <Link
                  key={document.id}
                  href={`/documents/${document.id}`}
                  className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200"
                >
                  <div className="rounded-xl bg-slate-100 p-2 text-slate-500">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-navy-950">{friendlyDocumentName(document.name)}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.tone}`}>{status.label}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
                        <Clock3 className="h-3 w-3" />
                        {toRelativeTime(document.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-300" />
                </Link>
              );
            })
          ) : (
            <div className="rounded-2xl bg-white p-4 text-sm font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200">
              No documents yet.
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-black uppercase tracking-[0.08em] text-slate-500">Continue Working</h2>
        <div className="grid grid-cols-2 gap-2">
          {shortcuts.map((shortcut) => (
            <Link
              key={shortcut.id}
              href={shortcut.href}
              className="flex min-h-14 items-center gap-2 rounded-2xl bg-white px-3 py-2 text-sm font-semibold text-navy-950 shadow-sm ring-1 ring-slate-200"
            >
              <shortcut.icon className="h-4 w-4 text-royal-600" />
              <span className="truncate">{shortcut.title}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="h-5 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-2 h-9 w-28 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 h-4 w-52 animate-pulse rounded bg-slate-100" />
        <div className="mt-4 h-12 w-full animate-pulse rounded-2xl bg-slate-100" />
      </section>
      <section className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, idx) => (
          <div key={idx} className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
            <div className="mt-3 h-7 w-14 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </section>
      <section className="space-y-2">
        {Array.from({ length: 3 }).map((_, idx) => (
          <div key={idx} className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <div className="h-4 w-44 animate-pulse rounded bg-slate-100" />
            <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </section>
    </div>
  );
}

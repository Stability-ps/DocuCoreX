"use client";

import { useEffect, useState } from "react";
import { Activity, BookOpenText, CloudUpload, Download, FileText, ScanText } from "lucide-react";
import { MetricCard, SectionPanel } from "@/components/ui";

type Usage = {
  documentsUploaded?: number;
  documents_uploaded?: number;
  pagesProcessed?: number;
  pages_processed?: number;
  ocrCreditsRemaining?: number;
  ocr_credits_remaining?: number;
  storageBytes?: number;
  storage_bytes?: number;
  exportsCreated?: number;
  exports_created?: number;
};

type Job = {
  id: string;
  type: string;
  status: string;
  progress: number;
  message: string;
};

function formatBytes(value: number) {
  if (!value) return "0 GB";
  const tb = value / 1024 / 1024 / 1024 / 1024;
  if (tb >= 1) return `${tb.toFixed(1)} TB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function DashboardLive() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    async function load() {
      const [usageResponse, jobsResponse] = await Promise.all([fetch("/api/usage"), fetch("/api/jobs")]);
      if (usageResponse.ok) {
        const data = (await usageResponse.json()) as { usage: Usage };
        setUsage(data.usage);
      }
      if (jobsResponse.ok) {
        const data = (await jobsResponse.json()) as { jobs: Job[] };
        setJobs(data.jobs);
      }
    }

    void load();
  }, []);

  const documents = usage?.documentsUploaded ?? usage?.documents_uploaded ?? 1284;
  const pages = usage?.pagesProcessed ?? usage?.pages_processed ?? 48930;
  const credits = usage?.ocrCreditsRemaining ?? usage?.ocr_credits_remaining ?? 86400;
  const storage = usage?.storageBytes ?? usage?.storage_bytes ?? 2.8 * 1024 * 1024 * 1024 * 1024;
  const exportsCreated = usage?.exportsCreated ?? usage?.exports_created ?? 9718;

  const metrics = [
    { label: "Documents Uploaded", value: documents.toLocaleString(), detail: "Current billing period", icon: FileText },
    { label: "Pages Processed", value: pages.toLocaleString(), detail: "OCR and extraction volume", icon: BookOpenText },
    { label: "OCR Credits Remaining", value: credits.toLocaleString(), detail: "Available workspace credits", icon: ScanText },
    { label: "Storage Used", value: formatBytes(storage), detail: "Secure vault usage", icon: CloudUpload },
    { label: "Exports", value: exportsCreated.toLocaleString(), detail: "Excel, CSV and JSON", icon: Download },
    { label: "Active Jobs", value: jobs.length.toLocaleString(), detail: "Processing queue", icon: Activity },
  ];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((stat) => (
          <MetricCard key={stat.label} {...stat} />
        ))}
      </div>

      <SectionPanel title="Processing Queue" description="Live OCR, extraction, conversion and export jobs.">
        <div className="grid gap-3 lg:grid-cols-3">
          {jobs.map((job) => (
            <div key={job.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-black capitalize text-navy-950">{job.type.replace("_", " ")}</p>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-royal-700">{job.status}</span>
              </div>
              <p className="mt-2 text-sm text-slate-500">{job.message}</p>
              <div className="mt-4 h-2 rounded-full bg-white">
                <div className="h-full rounded-full bg-royal-600" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          ))}
        </div>
      </SectionPanel>
    </>
  );
}


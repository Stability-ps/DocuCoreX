import type { DocumentStatus } from "@/lib/types";

type StatusConfig = {
  label: string;
  className: string;
  dot: string;
  pulse?: boolean;
};

const STATUS_CONFIG: Record<DocumentStatus, StatusConfig> = {
  uploaded: {
    label: "Uploaded",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    dot: "bg-slate-400",
  },
  queued: {
    label: "Queued",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "bg-blue-500",
  },
  processing: {
    label: "Processing",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    dot: "bg-blue-500",
    pulse: true,
  },
  review: {
    label: "Review Required",
    className: "border-amber-200 bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
  },
  ready: {
    label: "Completed",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    className: "border-rose-200 bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
  },
  archived: {
    label: "Archived",
    className: "border-slate-200 bg-slate-100 text-slate-500",
    dot: "bg-slate-400",
  },
};

export function statusLabel(status: DocumentStatus): string {
  return STATUS_CONFIG[status]?.label ?? "Unknown";
}

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.uploaded;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold ${config.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot} ${config.pulse ? "animate-pulse" : ""}`} />
      {config.label}
    </span>
  );
}

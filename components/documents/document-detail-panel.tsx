"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  RefreshCcw,
  ScanSearch,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import type {
  DocumentDownload,
  DocumentRecord,
  DocumentVersion,
  ExtractionResult,
  OcrResult,
  ProcessingJob,
} from "@/lib/types";
import { DocumentStatusBadge, statusLabel } from "@/components/documents/document-status-badge";
import { detectedTypeLabel, formatBytes, formatRelativeTime } from "@/components/documents/document-card";
import { DocumentViewer, type DocumentViewerKind } from "@/components/document-viewer";
import { ExtractionSummary } from "@/components/pdf/extraction-summary";
import { createDocumentConversion, waitForDownloadReady, wakeConversionWorker } from "@/components/documents/conversion-client";
import { useEscapeToClose } from "@/lib/use-escape-to-close";

type DetailData = {
  document?: DocumentRecord;
  jobs: ProcessingJob[];
  ocr?: OcrResult;
  extraction?: ExtractionResult;
  downloads?: DocumentDownload[];
  versions?: DocumentVersion[];
};

const TABS = ["Overview", "Preview", "OCR Text", "Extracted Data", "History"] as const;
type Tab = (typeof TABS)[number];

const CONVERT_TARGETS = ["pdf", "word", "excel", "zip"] as const;

export function DocumentDetailPanel({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [data, setData] = useState<DetailData>({ jobs: [] });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [tab, setTab] = useState<Tab>("Overview");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [showConvert, setShowConvert] = useState(false);
  useEscapeToClose(showConvert, () => setShowConvert(false));

  const downloadUrl = `/api/documents/${documentId}/download`;
  const previewUrl = `/api/documents/${documentId}/preview`;

  const loadCore = useCallback(async () => {
    const [documentResponse, ocrResponse, extractionResponse] = await Promise.all([
      fetch(`/api/documents/${documentId}`, { cache: "no-store" }),
      fetch(`/api/ocr/${documentId}`, { cache: "no-store" }),
      fetch(`/api/extractions/${documentId}`, { cache: "no-store" }),
    ]);

    if (documentResponse.status === 404) {
      setLoadState("not_found");
      return;
    }
    if (!documentResponse.ok) {
      setLoadState("error");
      return;
    }

    const documentData = (await documentResponse.json()) as { document: DocumentRecord; jobs: ProcessingJob[] };
    const ocrData = ocrResponse.ok ? ((await ocrResponse.json()) as { ocr?: OcrResult }) : { ocr: undefined };
    const extractionData = extractionResponse.ok
      ? ((await extractionResponse.json()) as { extraction?: ExtractionResult })
      : { extraction: undefined };

    setData((current) => ({
      ...current,
      document: documentData.document,
      jobs: documentData.jobs ?? [],
      ocr: ocrData.ocr,
      extraction: extractionData.extraction,
    }));
    setLoadState("ready");
  }, [documentId]);

  const loadSecondary = useCallback(async () => {
    const [downloadsResponse, historyResponse] = await Promise.all([
      fetch(`/api/downloads/${documentId}`, { cache: "no-store" }).catch(() => null),
      fetch(`/api/history/${documentId}`, { cache: "no-store" }).catch(() => null),
    ]);
    const downloadsData = downloadsResponse?.ok
      ? ((await downloadsResponse.json()) as { downloads?: DocumentDownload[] })
      : { downloads: undefined };
    const historyData = historyResponse?.ok
      ? ((await historyResponse.json()) as { versions?: DocumentVersion[] })
      : { versions: undefined };
    setData((current) => ({
      ...current,
      downloads: downloadsData.downloads,
      versions: historyData.versions,
    }));
  }, [documentId]);

  useEffect(() => {
    void loadCore();
    void loadSecondary();
  }, [loadCore, loadSecondary]);

  const doc = data.document;

  async function runProcess() {
    setBusy(true);
    setStatus("Running OCR and extraction…");
    try {
      await fetch(`/api/ocr/${documentId}`, { method: "POST" }).catch(() => null);
      await fetch(`/api/extractions/${documentId}`, { method: "POST" }).catch(() => null);
      await loadCore();
      await loadSecondary();
      setStatus("Processing complete.");
    } finally {
      setBusy(false);
    }
  }

  async function runConvert(target: (typeof CONVERT_TARGETS)[number]) {
    setShowConvert(false);
    setBusy(true);
    setStatus(`Converting to ${target.toUpperCase()}…`);
    try {
      const conversion = await createDocumentConversion(documentId, target);
      await wakeConversionWorker(conversion);
      await waitForDownloadReady(conversion, {
        onStatus: setStatus,
      });
      await loadSecondary();
      setStatus("Conversion complete. Download is ready in History.");
    } catch (error) {
      await loadSecondary();
      setStatus(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleShare() {
    if (!doc) return;
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared: !doc.shared }),
    }).catch(() => null);
    if (response?.ok) {
      const payload = (await response.json()) as { document: DocumentRecord };
      setData((current) => ({ ...current, document: payload.document }));
      setStatus(payload.document.shared ? "Document shared." : "Sharing turned off.");
    }
  }

  async function deleteDocument() {
    setBusy(true);
    setStatus("Moving to Trash…");
    const response = await fetch(`/api/documents/${documentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletedAt: new Date().toISOString() }),
    }).catch(() => null);
    if (response?.ok) {
      router.push("/documents");
    } else {
      setBusy(false);
      setStatus("Unable to delete document.");
    }
  }

  const previewKind = useMemo(() => {
    if (!doc) return "none";
    const mime = doc.mimeType.toLowerCase();
    if (mime.includes("pdf")) return "pdf";
    if (mime.startsWith("image/")) return "image";
    return "other";
  }, [doc]);

  if (loadState === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-royal-600" />
      </div>
    );
  }

  if (loadState === "not_found") {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <FileText className="h-10 w-10 text-slate-300" />
        <p className="text-base font-bold text-navy-950">Document not found</p>
        <Link href="/documents" className="text-sm font-bold text-royal-700">
          Back to Documents
        </Link>
      </div>
    );
  }

  if (loadState === "error" || !doc) {
    return (
      <div className="p-8">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-700">Unable to load this document.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 pb-24 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col gap-3">
        <Link href="/documents" className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 hover:text-navy-950">
          <ArrowLeft className="h-4 w-4" />
          All Documents
        </Link>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-navy-950 sm:text-2xl">{doc.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
              <DocumentStatusBadge status={doc.status} />
              <span>{detectedTypeLabel(doc.detectedType)}</span>
              <span className="text-slate-300">•</span>
              <span>{formatBytes(doc.sizeBytes)}</span>
              {doc.pageCount ? (
                <>
                  <span className="text-slate-300">•</span>
                  <span>{doc.pageCount} pages</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(doc.status === "uploaded" || doc.status === "failed") && !busy ? (
              <ActionButton icon={ScanSearch} label="Process" tone="primary" onClick={runProcess} />
            ) : null}
            <ActionButton icon={RefreshCcw} label="Convert" onClick={() => setShowConvert(true)} disabled={busy} />
            <ActionButton icon={Download} label="Download" onClick={() => window.open(downloadUrl, "_blank", "noopener,noreferrer")} />
            <ActionButton icon={Share2} label={doc.shared ? "Shared" : "Share"} onClick={toggleShare} />
            <ActionButton icon={Trash2} label="Delete" tone="danger" onClick={deleteDocument} disabled={busy} />
          </div>
        </div>
      </div>

      {status ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-600">
            {busy ? <Loader2 className="h-4 w-4 animate-spin text-royal-600" /> : null}
            {status}
          </p>
          <button type="button" onClick={() => setStatus("")} aria-label="Dismiss" className="text-slate-400">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-xs font-bold transition ${
              tab === item ? "bg-white text-navy-950 shadow-sm" : "text-slate-500 hover:text-navy-950"
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "Overview" ? <OverviewTab doc={doc} jobs={data.jobs} /> : null}
      {tab === "Preview" ? <PreviewTab kind={previewKind} previewUrl={previewUrl} downloadUrl={downloadUrl} name={doc.name} /> : null}
      {tab === "OCR Text" ? <OcrTab ocr={data.ocr} onRun={runProcess} busy={busy} /> : null}
      {tab === "Extracted Data" ? <ExtractionTab extraction={data.extraction} onRun={runProcess} busy={busy} /> : null}
      {tab === "History" ? <HistoryTab versions={data.versions} downloads={data.downloads} /> : null}

      {showConvert ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 p-4 sm:items-center" onClick={() => setShowConvert(false)} role="dialog" aria-modal="true" aria-label="Convert to another format">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-navy-950">Convert to…</h2>
              <button type="button" onClick={() => setShowConvert(false)} aria-label="Close" className="text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {CONVERT_TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  onClick={() => void runConvert(target)}
                  className="rounded-xl border border-slate-200 bg-white p-3 text-sm font-bold text-navy-950 transition hover:border-royal-300 hover:bg-royal-50"
                >
                  {target.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  tone = "default",
  disabled = false,
}: {
  icon: typeof Download;
  label: string;
  onClick: () => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
}) {
  const toneClass =
    tone === "primary"
      ? "border-royal-200 bg-royal-600 text-white hover:bg-royal-700"
      : tone === "danger"
        ? "border-rose-200 bg-white text-rose-600 hover:bg-rose-50"
        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-bold transition disabled:opacity-40 ${toneClass}`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function OverviewTab({ doc, jobs }: { doc: DocumentRecord; jobs: ProcessingJob[] }) {
  const isPdf = (doc.mimeType || "").toLowerCase().includes("pdf");
  const metadata: Array<{ label: string; value: string }> = [
    { label: "Status", value: statusLabel(doc.status) },
    { label: "Detected type", value: detectedTypeLabel(doc.detectedType) },
    { label: "File type", value: doc.mimeType || "—" },
    { label: "Size", value: formatBytes(doc.sizeBytes) },
    { label: "Pages", value: doc.pageCount ? String(doc.pageCount) : "—" },
    { label: "Shared", value: doc.shared ? "Yes" : "No" },
    { label: "Created", value: formatRelativeTime(doc.createdAt) },
    { label: "Updated", value: formatRelativeTime(doc.updatedAt) },
  ];

  return (
    <div className="space-y-4">
      {isPdf ? <ExtractionSummary documentId={doc.id} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Metadata</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          {metadata.map((row) => (
            <div key={row.label}>
              <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{row.label}</dt>
              <dd className="mt-0.5 truncate text-sm font-semibold text-navy-950">{row.value}</dd>
            </div>
          ))}
        </dl>
        {doc.tags.length ? (
          <div className="mt-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Tags</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {doc.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Processing pipeline</h2>
        {jobs.length ? (
          <ul className="mt-3 space-y-2">
            {jobs.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold capitalize text-navy-950">{job.type.replace(/_/g, " ")}</p>
                  <p className="truncate text-xs font-semibold text-slate-500">{job.message || job.status}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black ${
                    job.status === "completed"
                      ? "bg-emerald-50 text-emerald-700"
                      : job.status === "failed"
                        ? "bg-rose-50 text-rose-700"
                        : "bg-blue-50 text-blue-700"
                  }`}
                >
                  {job.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm font-semibold text-slate-500">No processing jobs yet.</p>
        )}
      </section>
      </div>
    </div>
  );
}

function PreviewTab({ kind, previewUrl, downloadUrl, name }: { kind: string; previewUrl: string; downloadUrl: string; name: string }) {
  // Shared pdf.js canvas viewer: fit-width by default, renders inline (previewUrl);
  // Download uses the attachment endpoint (downloadUrl).
  const viewerKind: DocumentViewerKind = kind === "pdf" ? "pdf" : kind === "image" ? "image" : "other";
  return <DocumentViewer sourceUrl={previewUrl} downloadUrl={downloadUrl} fileName={name} kind={viewerKind} minHeightClass="h-[calc(100vh-13rem)] max-h-[90vh] min-h-[78vh]" />;
}

function OcrTab({ ocr, onRun, busy }: { ocr?: OcrResult; onRun: () => void; busy: boolean }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">OCR text</h2>
        <ActionButton icon={ScanSearch} label={ocr ? "Re-run OCR" : "Run OCR"} tone="primary" onClick={onRun} disabled={busy} />
      </div>
      {ocr ? (
        <>
          <p className="mt-2 text-xs font-semibold text-slate-500">
            Language {ocr.language} · {Math.round(ocr.confidence)}% confidence
          </p>
          <pre className="mt-3 max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-navy-950">
            {ocr.text || "No text detected."}
          </pre>
        </>
      ) : (
        <p className="mt-3 text-sm font-semibold text-slate-500">No OCR results yet. Run OCR to extract the text layer.</p>
      )}
    </section>
  );
}

function ExtractionTab({ extraction, onRun, busy }: { extraction?: ExtractionResult; onRun: () => void; busy: boolean }) {
  const fields = extraction ? Object.entries(extraction.fields) : [];
  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Extracted data</h2>
          <ActionButton icon={ScanSearch} label={extraction ? "Re-run" : "Extract"} tone="primary" onClick={onRun} disabled={busy} />
        </div>
        {extraction ? (
          <>
            <p className="mt-2 text-xs font-semibold text-slate-500">
              {detectedTypeLabel(extraction.detectedType)} · {Math.round(extraction.confidence)}% confidence
            </p>
            {fields.length ? (
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                {fields.map(([key, value]) => (
                  <div key={key} className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{key.replace(/_/g, " ")}</dt>
                    <dd className="mt-0.5 text-sm font-semibold text-navy-950">{value === null ? "—" : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-3 text-sm font-semibold text-slate-500">No fields extracted.</p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm font-semibold text-slate-500">No extraction yet. Run extraction to pull structured fields.</p>
        )}
      </div>

      {extraction && extraction.lineItems.length ? (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h3 className="text-sm font-black uppercase tracking-wide text-slate-500">Line items ({extraction.lineItems.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {Object.keys(extraction.lineItems[0]).map((column) => (
                    <th key={column} className="px-3 py-2 text-left text-[11px] font-black uppercase tracking-wide text-slate-500">
                      {column.replace(/_/g, " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {extraction.lineItems.slice(0, 50).map((row, index) => (
                  <tr key={index}>
                    {Object.values(row).map((value, cellIndex) => (
                      <td key={cellIndex} className="px-3 py-2 font-semibold text-navy-950">
                        {value === null ? "—" : String(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function HistoryTab({ versions, downloads }: { versions?: DocumentVersion[]; downloads?: DocumentDownload[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Converted outputs</h2>
        {downloads?.length ? (
          <ul className="mt-3 space-y-2">
            {downloads.map((download) => (
              <li key={download.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-navy-950">{download.label}</p>
                  <p className="text-[11px] font-semibold uppercase text-slate-400">{download.format}</p>
                </div>
                {download.status === "ready" && download.href ? (
                  <a
                    href={download.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-royal-200 bg-royal-50 px-3 text-xs font-black text-royal-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black capitalize text-slate-500">
                    {download.status}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm font-semibold text-slate-500">No converted outputs yet. Use Convert to generate one.</p>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Version history</h2>
        {versions?.length ? (
          <ul className="mt-3 space-y-2">
            {versions.map((version) => (
              <li key={version.id} className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                <p className="text-sm font-bold text-navy-950">Version {version.versionNumber}</p>
                <p className="text-xs font-semibold text-slate-500">
                  {version.changeNote || "Uploaded"} · {formatRelativeTime(version.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm font-semibold text-slate-500">No version history recorded.</p>
        )}
      </section>
    </div>
  );
}

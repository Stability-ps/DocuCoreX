"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileOutput, FolderOpen, Play, RefreshCcw, UploadCloud, X } from "lucide-react";
import { conversionOptions } from "@/lib/product-data";
import type { DocumentRecord } from "@/lib/types";

type ConversionResponse = {
  conversion?: {
    id: string;
    documentId: string;
    from: string;
    to: string;
    status: string;
    downloadUrl?: string | null;
    job?: {
      id: string;
      status: string;
    } | null;
  };
};

type JobsResponse = {
  jobs?: Array<{ id: string; document_id?: string; documentId?: string; type: string; status: string; progress: number; message: string }>;
};

type DownloadsResponse = {
  downloads?: Array<{ id: string; status: string; href?: string; label?: string }>;
};

type LifecycleState = "ready" | "processing" | "completed";

type ConversionDebugState = {
  conversionId: string;
  jobId: string;
  status: string;
};

type CompletedResult = {
  conversionId: string;
  sourceDocumentId: string;
  sourceName: string;
  targetLabel: string;
  targetFormat: string;
  downloadHref: string;
  resultDocumentId: string | null;
  resultDocumentName: string;
  savedToLibrary: boolean;
  createdAt: number;
};

const activeDocumentKey = "docucorex.convert.activeDocumentId";

function normalizeFormat(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "images") return "image";
  if (normalized === "word") return "word";
  if (normalized === "excel") return "excel";
  return normalized;
}

function documentSourceFormat(document: DocumentRecord) {
  const lower = `${document.mimeType} ${document.name}`.toLowerCase();
  if (lower.includes("pdf") || /\.pdf$/i.test(document.name)) return "pdf";
  if (lower.includes("word") || /\.(docx?|rtf|txt)$/i.test(document.name)) return "word";
  if (lower.includes("excel") || lower.includes("spreadsheet") || /\.(xlsx?|xls|csv)$/i.test(document.name)) return "excel";
  if (lower.includes("image") || /\.(png|jpe?g|tiff?|bmp|gif|heic)$/i.test(document.name)) return "image";
  return "unknown";
}

function isConvertedDocument(document: DocumentRecord) {
  return (document.tags ?? []).some((tag) => tag.toLowerCase() === "converted");
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConversionWorkflow() {
  const [selectedTarget, setSelectedTarget] = useState("PDF → Excel");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [lifecycleState, setLifecycleState] = useState<LifecycleState>("ready");
  const [progress, setProgress] = useState(0);
  const [jobLabel, setJobLabel] = useState("Ready");
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState("");
  const [activeResult, setActiveResult] = useState<CompletedResult | null>(null);
  const [activeJobDocumentName, setActiveJobDocumentName] = useState("");
  const [activeJobTarget, setActiveJobTarget] = useState("");
  const [librarySavingIds, setLibrarySavingIds] = useState<Record<string, true>>({});
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "failed">("idle");
  const [conversionDebug, setConversionDebug] = useState<ConversionDebugState | null>(null);
  const lifecycleCardRef = useRef<HTMLDivElement>(null);

  async function loadDocuments(preferredId?: string) {
      const response = await fetch("/api/documents").catch(() => null);
      if (!response?.ok) return;

      const data = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents);
    setSelectedDocumentId((current) => {
      const saved = preferredId ?? (typeof window !== "undefined" ? window.localStorage.getItem(activeDocumentKey) : "") ?? "";
      const nextId = data.documents.find((document) => document.id === current)?.id ?? data.documents.find((document) => document.id === saved)?.id ?? current;
      if (nextId && typeof window !== "undefined") window.localStorage.setItem(activeDocumentKey, nextId);
      return nextId;
    });
    }

  useEffect(() => {
    void loadDocuments();
  }, []);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedDocumentId),
    [documents, selectedDocumentId],
  );

  const selectedSourceFormat = useMemo(() => {
    const [fromLabel] = selectedTarget.split(" → ");
    return fromLabel ? normalizeFormat(fromLabel) : "";
  }, [selectedTarget]);

  const compatibleDocuments = useMemo(
    () =>
      documents.filter(
        (document) =>
          !document.deletedAt &&
          !isConvertedDocument(document) &&
          (!selectedSourceFormat || documentSourceFormat(document) === selectedSourceFormat),
      ),
    [documents, selectedSourceFormat],
  );

  useEffect(() => {
    setSelectedDocumentId((current) => {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(activeDocumentKey) : "";
      const nextId = compatibleDocuments.some((document) => document.id === current)
        ? current
        : compatibleDocuments.find((document) => document.id === saved)?.id ?? compatibleDocuments[0]?.id ?? "";
      if (nextId && typeof window !== "undefined") window.localStorage.setItem(activeDocumentKey, nextId);
      return nextId;
    });
  }, [compatibleDocuments]);

  function selectDocument(id: string) {
    setSelectedDocumentId(id);
    if (id) window.localStorage.setItem(activeDocumentKey, id);
  }

  async function uploadDocument(file?: File | null) {
    if (!file) return;
    setUploadState("uploading");
    setError("");
    const formData = new FormData();
    formData.append("file", file, file.name);
    const response = await fetch("/api/uploads", { method: "POST", body: formData }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as { accepted?: Array<{ id: string }>; error?: string } | null;
    if (!response?.ok || !data?.accepted?.[0]?.id) {
      setUploadState("failed");
      setError(data?.error ?? "Upload failed.");
      return;
    }
    await loadDocuments(data.accepted[0].id);
    setUploadState("idle");
  }

  async function findLatestConvertedDocument(sourceDocumentId: string, startedAt: number) {
    const response = await fetch("/api/documents").catch(() => null);
    if (!response?.ok) return null;

    const data = (await response.json().catch(() => null)) as { documents?: DocumentRecord[] } | null;
    if (!data?.documents?.length) return null;

    setDocuments(data.documents);

    return (
      data.documents
        .filter((document) => {
          if (document.id === sourceDocumentId || document.deletedAt) return false;
          const createdAt = new Date(document.createdAt).getTime();
          const hasConvertedTag = (document.tags ?? []).some((tag) => tag.toLowerCase() === "converted");
          return hasConvertedTag && createdAt >= startedAt - 2 * 60_000;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
    );
  }

  function focusLifecycleCard() {
    window.requestAnimationFrame(() => {
      lifecycleCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      lifecycleCardRef.current?.focus({ preventScroll: true });
    });
  }

  async function saveToLibrary(result: CompletedResult) {
    if (!result.resultDocumentId || librarySavingIds[result.conversionId]) return;

    setLibrarySavingIds((current) => ({ ...current, [result.conversionId]: true }));
    setError("");

    try {
      const existingDocument = documents.find((document) => document.id === result.resultDocumentId);
      const nextTags = Array.from(new Set([...(existingDocument?.tags ?? []), "Library", "Converted"]));
      const response = await fetch(`/api/documents/${result.resultDocumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: true, tags: nextTags }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Unable to save document to library.");
      }

      setActiveResult((current) => (current?.conversionId === result.conversionId ? { ...current, savedToLibrary: true } : current));
      setJobLabel("Saved to Library");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save document to library.");
    } finally {
      setLibrarySavingIds((current) => {
        const next = { ...current };
        delete next[result.conversionId];
        return next;
      });
    }
  }

  function previewResult(result: CompletedResult) {
    if (result.targetFormat === "pdf" || result.targetFormat === "image") {
      window.open(result.downloadHref, "_blank", "noopener,noreferrer");
      return;
    }
    if (result.resultDocumentId) {
      window.location.href = `/documents/${result.resultDocumentId}`;
      return;
    }
    window.open(result.downloadHref, "_blank", "noopener,noreferrer");
  }

  async function downloadResult(result: CompletedResult) {
    const response = await fetch(result.downloadHref).catch(() => null);
    if (!response?.ok) {
      const data = (await response?.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "The converted file is not ready to download yet.");
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.resultDocumentName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function resetForAnotherConversion() {
    setSelectedTarget("");
    setLifecycleState("ready");
    setActiveResult(null);
    setConversionDebug(null);
    setActiveJobDocumentName("");
    setActiveJobTarget("");
    setProgress(0);
    setJobLabel("Ready");
    setError("");
  }

  async function startConversion() {
    if (!selectedTarget) {
      setError("Choose a conversion target before starting conversion.");
      return;
    }
    if (!selectedDocumentId) {
      setError("Select a source document before starting conversion.");
      return;
    }

    setError("");
    setLifecycleState("processing");
    setActiveResult(null);
    setConversionDebug(null);
    setActiveJobDocumentName(selectedDocument?.name ?? "Selected document");
    setActiveJobTarget(selectedTarget);
    setIsConverting(true);
    setProgress(18);
    setJobLabel("Creating conversion job");
    const startedAt = Date.now();
    const [fromLabel, toLabel] = selectedTarget.split(" → ");
    const response = await fetch("/api/conversions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId: selectedDocumentId,
        from: normalizeFormat(fromLabel),
        to: normalizeFormat(toLabel),
      }),
    }).catch(() => null);

    if (!response?.ok) {
      const data = (await response?.json().catch(() => null)) as { error?: string } | null;
      setJobLabel("Conversion failed");
      setError(data?.error ?? "Unable to create conversion job.");
      setLifecycleState("ready");
      setIsConverting(false);
      setProgress(0);
      return;
    }

    const data = (await response.json().catch(() => null)) as ConversionResponse | null;
    const conversionId = data?.conversion?.id;
    const createdJobId = data?.conversion?.job?.id ?? "";
    if (conversionId) {
      setConversionDebug({
        conversionId,
        jobId: createdJobId || "pending",
        status: data?.conversion?.status ?? "queued",
      });
    }
    setJobLabel("Job queued");
    setProgress(34);

    const processResponse = await fetch("/api/jobs/process", { method: "POST" }).catch(() => null);

    if (!processResponse?.ok) {
      setJobLabel("Processing failed");
      setError("Conversion job was created, but processing could not start.");
      setLifecycleState("ready");
      setIsConverting(false);
      return;
    }

    setProgress(76);
    const jobsResponse = await fetch("/api/jobs").catch(() => null);
    const jobsData = jobsResponse?.ok ? ((await jobsResponse.json().catch(() => null)) as JobsResponse | null) : null;
    const matchingJob =
      jobsData?.jobs?.find((job) => createdJobId && job.id === createdJobId) ??
      jobsData?.jobs?.find(
        (job) => job.type === "conversion" && (job.documentId === selectedDocumentId || job.document_id === selectedDocumentId),
      );

    if (conversionId) {
      setConversionDebug({
        conversionId,
        jobId: matchingJob?.id ?? (createdJobId || "pending"),
        status: matchingJob?.status ?? data?.conversion?.status ?? "queued",
      });
    }

    if (matchingJob?.status === "failed") {
      setJobLabel("Conversion failed");
      if (conversionId) {
        setConversionDebug({
          conversionId,
          jobId: matchingJob?.id ?? (createdJobId || "pending"),
          status: "failed",
        });
      }
      setError(matchingJob.message || "Conversion failed.");
      setLifecycleState("ready");
      setIsConverting(false);
      return;
    }

    const downloadsResponse = await fetch(`/api/downloads/${selectedDocumentId}`, { cache: "no-store" }).catch(() => null);
    const downloadsData = downloadsResponse?.ok ? ((await downloadsResponse.json().catch(() => null)) as DownloadsResponse | null) : null;
    const readyDownload = downloadsData?.downloads?.find((download) => download.id === conversionId && download.status === "ready" && download.href);

    if (!readyDownload?.href) {
      setProgress(76);
      setJobLabel("Conversion failed");
      if (conversionId) {
        setConversionDebug({
          conversionId,
          jobId: matchingJob?.id ?? (createdJobId || "pending"),
          status: "missing_output",
        });
      }
      setError("The conversion finished without a downloadable output. Please run it again.");
      setLifecycleState("ready");
      setIsConverting(false);
      return;
    }

    const downloadHref = readyDownload.href;
    const convertedDocument = await findLatestConvertedDocument(selectedDocumentId, startedAt);
    const completedResult: CompletedResult = {
      conversionId: conversionId ?? `conversion_${selectedDocumentId}_${Date.now()}`,
      sourceDocumentId: selectedDocumentId,
      sourceName: selectedDocument?.name ?? "Converted file",
      targetLabel: selectedTarget,
      targetFormat: normalizeFormat(toLabel),
      downloadHref,
      resultDocumentId: convertedDocument?.id ?? null,
      resultDocumentName: convertedDocument?.name ?? `${selectedDocument?.name ?? "Document"} (${toLabel})`,
      savedToLibrary: false,
      createdAt: Date.now(),
    };

    setProgress(100);
    setIsConverting(false);
    setLifecycleState("completed");
    setJobLabel("Completed");
    if (conversionId) {
      setConversionDebug({
        conversionId,
        jobId: matchingJob?.id ?? (createdJobId || "pending"),
        status: "output_ready",
      });
    }
    setSelectedTarget("");
    setActiveResult(completedResult);
    focusLifecycleCard();
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold text-navy-950">Conversion Job</h2>
      <p className="mt-1 text-sm leading-6 text-slate-500">Ready to convert, processing, and completed results all update in this same card.</p>

      {conversionDebug && process.env.NODE_ENV !== "production" ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="font-black uppercase tracking-[0.08em] text-amber-700">Temporary conversion debug</p>
              <p className="break-all font-mono">
                <span className="font-sans font-bold">conversion_id:</span> {conversionDebug.conversionId}
              </p>
              <p className="break-all font-mono">
                <span className="font-sans font-bold">job_id:</span> {conversionDebug.jobId}
              </p>
              <p className="font-mono">
                <span className="font-sans font-bold">current status:</span> {conversionDebug.status}
              </p>
            </div>
            <a
              href={`/api/conversions/${conversionDebug.conversionId}/debug`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-amber-600 px-3 text-sm font-bold text-white shadow-sm hover:bg-amber-700"
            >
              Debug
            </a>
          </div>
        </div>
      ) : null}

      {lifecycleState === "ready" ? (
        <div ref={lifecycleCardRef} tabIndex={-1} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 outline-none">
          <p className="text-xs font-black uppercase tracking-[0.08em] text-slate-500">After upload, convert to</p>
          <div className="mt-3">
            {selectedDocument ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-navy-950">{selectedDocument.name}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{selectedDocument.mimeType} · {bytes(selectedDocument.sizeBytes)} · Uploaded successfully</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg bg-white px-3 text-xs font-black text-royal-700 shadow-sm">
                    Replace Document
                    <input className="sr-only" type="file" onChange={(event) => void uploadDocument(event.target.files?.[0])} />
                  </label>
                  <button type="button" onClick={() => setLibraryOpen(true)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                    <FolderOpen className="h-4 w-4" />
                    Choose from Document Library
                  </button>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void uploadDocument(event.dataTransfer.files?.[0]);
                }}
                className="rounded-xl border border-dashed border-royal-200 bg-white p-5 text-center"
              >
                <UploadCloud className="mx-auto h-8 w-8 text-royal-600" />
                <p className="mt-2 font-semibold text-navy-950">Upload document</p>
                <p className="mt-1 text-sm text-slate-500">Drag & drop or choose a file.</p>
                <label className="mt-3 inline-flex min-h-10 cursor-pointer items-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white">
                  Choose File
                  <input className="sr-only" type="file" onChange={(event) => void uploadDocument(event.target.files?.[0])} />
                </label>
                <button type="button" onClick={() => setLibraryOpen(true)} className="mt-3 block w-full text-xs font-black text-royal-700">
                  Choose from Document Library
                </button>
              </div>
            )}
            {uploadState === "uploading" ? <p className="mt-2 text-xs font-semibold text-royal-700">Uploading...</p> : null}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {conversionOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSelectedTarget(option)}
                className={`flex min-h-11 items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm font-semibold transition ${
                  selectedTarget === option ? "border-royal-300 bg-royal-50 text-royal-800" : "border-slate-200 bg-white text-navy-950 hover:bg-slate-50"
                }`}
              >
                <span className="flex items-center gap-3">
                  <RefreshCcw className="h-4 w-4 text-royal-600" />
                  {option}
                </span>
                {selectedTarget === option ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-navy-950">Status: Ready</p>
              <p className="text-xs text-slate-500">
                {!compatibleDocuments.length && selectedTarget ? `Upload or choose a ${selectedSourceFormat.toUpperCase()} source document first.` : selectedTarget || "Choose a conversion target"}
              </p>
              {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
            </div>
            <button
              type="button"
              onClick={startConversion}
              disabled={isConverting || !selectedDocumentId || !compatibleDocuments.length || !selectedTarget}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:bg-slate-300"
            >
              <Play className="h-4 w-4" />
              {!compatibleDocuments.length ? "Upload matching source" : !selectedTarget ? "Choose target" : "Convert"}
            </button>
          </div>
        </div>
      ) : null}

      {lifecycleState === "processing" ? (
        <div
          ref={lifecycleCardRef}
          tabIndex={-1}
          className="mt-4 rounded-xl border border-royal-200 bg-royal-50/50 p-4 outline-none focus-visible:ring-2 focus-visible:ring-royal-300"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-white p-2 text-royal-700">
              <FileOutput className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-navy-950">{activeJobDocumentName || selectedDocument?.name || "Selected document"}</p>
              <p className="truncate text-xs text-slate-500">{activeJobTarget || "Conversion in progress"}</p>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm font-semibold">
            <span>Status: Processing</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-royal-600 progress-stripe" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500">{jobLabel}</p>

          {error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p> : null}

          <button
            type="button"
            disabled
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-slate-300 px-4 py-2 text-sm font-semibold text-white"
          >
            <Play className="h-4 w-4" />
            Converting
          </button>
        </div>
      ) : null}

      {lifecycleState === "completed" && activeResult ? (
        <div
          ref={lifecycleCardRef}
          tabIndex={-1}
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
        >
          <div className="flex flex-col gap-2">
            <p className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-emerald-700 ring-1 ring-emerald-200">
              <CheckCircle2 className="h-4 w-4" />
              Completed
            </p>
            <p className="text-sm font-semibold text-navy-950">{activeResult.resultDocumentName}</p>
            <p className="text-xs font-semibold text-slate-500">{activeResult.targetLabel}</p>
          </div>

          <div className="mt-3 flex items-center justify-between text-sm font-semibold text-navy-950">
            <span>Status: Completed</span>
            <span>100%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-100">
            <div className="h-full w-full rounded-full bg-emerald-500" />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void downloadResult(activeResult)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-navy-950 px-3 text-sm font-semibold text-white sm:w-auto"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
            <button
              type="button"
              onClick={() => previewResult(activeResult)}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:w-auto"
            >
              Preview
            </button>
            {activeResult.resultDocumentId ? (
              <Link
                href={`/documents/${activeResult.resultDocumentId}`}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:w-auto"
              >
                Open Document
              </Link>
            ) : (
              <button
                type="button"
                disabled
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-100 px-3 text-sm font-semibold text-slate-400 sm:w-auto"
              >
                Open Document
              </button>
            )}
            <button
              type="button"
              onClick={() => void saveToLibrary(activeResult)}
              disabled={Boolean(librarySavingIds[activeResult.conversionId]) || activeResult.savedToLibrary || !activeResult.resultDocumentId}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 disabled:bg-slate-100 disabled:text-slate-400 sm:w-auto"
            >
              {activeResult.savedToLibrary ? "Saved to Library" : librarySavingIds[activeResult.conversionId] ? "Saving..." : "Save to Library"}
            </button>
          </div>

          <button
            type="button"
            onClick={resetForAnotherConversion}
            className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
          >
            Convert another file
          </button>
          {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
        </div>
      ) : null}
      {libraryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/40 p-4">
          <div className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <p className="font-semibold text-navy-950">Document Library</p>
                <p className="text-xs text-slate-500">Choose an existing source document.</p>
              </div>
              <button type="button" onClick={() => setLibraryOpen(false)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close library">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-auto p-3">
              {compatibleDocuments.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => {
                    selectDocument(document.id);
                    setLibraryOpen(false);
                  }}
                  className="mb-2 flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left hover:border-royal-200 hover:bg-royal-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-navy-950">{document.name}</span>
                    <span className="text-xs font-semibold text-slate-500">{document.mimeType} · {bytes(document.sizeBytes)}</span>
                  </span>
                  {selectedDocumentId === document.id ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : null}
                </button>
              ))}
              {!compatibleDocuments.length ? <p className="p-4 text-center text-sm font-semibold text-slate-500">No matching documents available yet.</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

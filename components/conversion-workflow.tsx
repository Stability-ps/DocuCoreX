"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Download, FileOutput, Play, RefreshCcw } from "lucide-react";
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
  };
};

type JobsResponse = {
  jobs?: Array<{ id: string; document_id?: string; documentId?: string; type: string; status: string; progress: number; message: string }>;
};

type LifecycleState = "ready" | "processing" | "completed";

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

function normalizeFormat(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "images") return "image";
  if (normalized === "word") return "word";
  if (normalized === "excel") return "excel";
  return normalized;
}

export function ConversionWorkflow() {
  const [selectedTarget, setSelectedTarget] = useState("PDF → Excel");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("statement-q2");
  const [lifecycleState, setLifecycleState] = useState<LifecycleState>("ready");
  const [progress, setProgress] = useState(0);
  const [jobLabel, setJobLabel] = useState("Ready");
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState("");
  const [activeResult, setActiveResult] = useState<CompletedResult | null>(null);
  const [activeJobDocumentName, setActiveJobDocumentName] = useState("");
  const [activeJobTarget, setActiveJobTarget] = useState("");
  const [librarySavingIds, setLibrarySavingIds] = useState<Record<string, true>>({});
  const lifecycleCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadDocuments() {
      const response = await fetch("/api/documents").catch(() => null);
      if (!response?.ok) return;

      const data = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents);
      setSelectedDocumentId((current) => data.documents.find((document) => document.id === current)?.id ?? data.documents[0]?.id ?? current);
    }

    void loadDocuments();
  }, []);

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedDocumentId),
    [documents, selectedDocumentId],
  );

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

  function resetForAnotherConversion() {
    setSelectedTarget("");
    setLifecycleState("ready");
    setActiveResult(null);
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
    const matchingJob = jobsData?.jobs?.find(
      (job) => job.type === "conversion" && (job.documentId === selectedDocumentId || job.document_id === selectedDocumentId),
    );

    if (matchingJob?.status === "failed") {
      setJobLabel("Conversion failed");
      setError(matchingJob.message || "Conversion failed.");
      setLifecycleState("ready");
      setIsConverting(false);
      return;
    }

    const downloadHref = data?.conversion?.downloadUrl ?? `/api/download-file/${conversionId ?? `conversion_${selectedDocumentId}`}`;
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
    setSelectedTarget("");
    setActiveResult(completedResult);
    focusLifecycleCard();
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold text-navy-950">Conversion Job</h2>
      <p className="mt-1 text-sm leading-6 text-slate-500">Ready to convert, processing, and completed results all update in this same card.</p>

      {lifecycleState === "ready" ? (
        <div ref={lifecycleCardRef} tabIndex={-1} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 outline-none">
          <p className="text-xs font-black uppercase tracking-[0.08em] text-slate-500">After upload, convert to</p>
          <label className="mt-3 block">
            <span className="mb-2 block text-sm font-semibold text-slate-700">Source document</span>
            <select
              className="min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
              onChange={(event) => setSelectedDocumentId(event.target.value)}
              value={selectedDocumentId}
              disabled={!documents.length}
            >
              {!documents.length ? <option value="">No documents available</option> : null}
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.name}
                </option>
              ))}
            </select>
          </label>

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
              <p className="text-xs text-slate-500">{selectedTarget || "Choose a conversion target"}</p>
              {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
            </div>
            <button
              type="button"
              onClick={startConversion}
              disabled={isConverting || !selectedDocumentId || !documents.length || !selectedTarget}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:bg-slate-300"
            >
              <Play className="h-4 w-4" />
              {!documents.length ? "Upload first" : !selectedTarget ? "Choose target" : "Convert"}
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
            <a
              href={activeResult.downloadHref}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-navy-950 px-3 text-sm font-semibold text-white sm:w-auto"
            >
              <Download className="h-4 w-4" />
              Download
            </a>
            <button
              type="button"
              onClick={() => previewResult(activeResult)}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:w-auto"
            >
              Preview
            </button>
            {activeResult.resultDocumentId ? (
              <a
                href={`/documents/${activeResult.resultDocumentId}`}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 sm:w-auto"
              >
                Open Document
              </a>
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
    </section>
  );
}

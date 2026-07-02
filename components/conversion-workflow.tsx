"use client";

import { useEffect, useMemo, useState } from "react";
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

function normalizeFormat(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "images") return "image";
  if (normalized === "word") return "word";
  if (normalized === "excel") return "excel";
  return normalized;
}

export function ConversionWorkflow() {
  const [selected, setSelected] = useState("PDF → Excel");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("statement-q2");
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);
  const [jobLabel, setJobLabel] = useState("Ready");
  const [downloadHref, setDownloadHref] = useState("");
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState("");

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

  async function startConversion() {
    if (!selectedDocumentId) {
      setError("Select a source document before starting conversion.");
      return;
    }

    setComplete(false);
    setDownloadHref("");
    setError("");
    setIsConverting(true);
    setProgress(18);
    setJobLabel("Creating conversion job");
    const [fromLabel, toLabel] = selected.split(" → ");
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
      setIsConverting(false);
      return;
    }

    setProgress(100);
    setComplete(true);
    setIsConverting(false);
    setJobLabel("Download ready");
    setDownloadHref(data?.conversion?.downloadUrl ?? `/api/download-file/${conversionId ?? `conversion_${selectedDocumentId}`}`);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-xl font-semibold text-navy-950">Choose Conversion</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">Convert common business formats with progress tracking and secure downloads.</p>
        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-semibold text-slate-700">Source document</span>
          <select
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300 focus:bg-white"
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
        <div className="mt-5 grid gap-3">
          {conversionOptions.map((option) => (
            <button
              key={option}
              onClick={() => setSelected(option)}
              className={`flex items-center justify-between rounded-2xl border p-4 text-left font-semibold transition ${
                selected === option ? "border-royal-300 bg-royal-50 text-royal-800" : "border-slate-200 bg-slate-50 text-navy-950 hover:bg-white"
              }`}
            >
              <span className="flex items-center gap-3">
                <RefreshCcw className="h-5 w-5 text-royal-600" />
                {option}
              </span>
              {selected === option ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-navy-950">Conversion Job</h2>
          <p className="mt-1 text-sm text-slate-500">Selected workflow: {selected} • {jobLabel}</p>
            {error ? <p className="mt-2 text-sm font-semibold text-rose-600">{error}</p> : null}
          </div>
          <button
            onClick={startConversion}
            disabled={isConverting || !selectedDocumentId || !documents.length}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-royal-600 px-5 py-3 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:bg-slate-300"
          >
            <Play className="h-4 w-4" />
            {isConverting ? "Converting" : !documents.length ? "Upload a document first" : "Start Conversion"}
          </button>
        </div>

        <div className="mt-6 rounded-[2rem] bg-navy-950 p-5 text-white navy-grid">
          <div className="flex items-center gap-4">
            <div className="rounded-2xl bg-white/10 p-3">
              <FileOutput className="h-6 w-6 text-sky-300" />
            </div>
            <div>
              <p className="font-semibold">{selectedDocument?.name ?? "Business Statement Q2.pdf"}</p>
              <p className="text-sm text-blue-100">Preserving layout, tables and extracted data</p>
            </div>
          </div>
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between text-sm font-semibold">
              <span>{complete ? "Conversion complete" : "Converting file…"}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-sky-300 progress-stripe" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {["Queued", "Processing", complete ? "Download ready" : "Preparing"].map((step, index) => (
            <div key={step} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Step {index + 1}</p>
              <p className="mt-2 font-semibold text-navy-950">{step}</p>
            </div>
          ))}
        </div>

        <a
          href={complete ? downloadHref : undefined}
          aria-disabled={!complete}
          className={`mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-white ${
            complete ? "bg-navy-950" : "pointer-events-none bg-slate-300"
          }`}
        >
          <Download className="h-5 w-5" />
          Download Converted File
        </a>
      </section>
    </div>
  );
}

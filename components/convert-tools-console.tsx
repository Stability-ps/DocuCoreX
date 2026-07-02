"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Columns3, FileSearch, Languages, PencilLine, ScanText, WandSparkles } from "lucide-react";
import { PageHeader, SectionPanel, StatusPill } from "@/components/ui";
import type { DocumentRecord } from "@/lib/types";

type OcrPayload = {
  ocr?: {
    id: string;
    text: string;
    confidence: number;
    language: string;
    createdAt: string;
  };
  error?: string;
};

type ExtractionPayload = {
  extraction?: {
    id: string;
    fields: Record<string, string | number | boolean | null>;
    lineItems: Array<Record<string, string | number | boolean | null>>;
    confidence: number;
    detectedType: string;
    createdAt: string;
  };
  error?: string;
};

type InsightPayload = {
  insight?: {
    id: string;
    prompt: string;
    answer: string;
    confidence: number;
    createdAt: string;
  };
  error?: string;
};

type OcrResult = NonNullable<OcrPayload["ocr"]>;
type ExtractionResult = NonNullable<ExtractionPayload["extraction"]>;
type InsightResult = NonNullable<InsightPayload["insight"]>;

function niceDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: string) {
  if (status === "processing") return "Processing";
  if (status === "ready") return "Ready";
  if (status === "review") return "Review";
  if (status === "failed") return "Failed";
  if (status === "queued") return "Queued";
  return "Uploaded";
}

function useDocuments() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      const response = await fetch("/api/documents").catch(() => null);
      if (!response?.ok) {
        setError("Unable to load documents.");
        return;
      }
      const data = (await response.json().catch(() => null)) as { documents?: DocumentRecord[] } | null;
      const next = data?.documents ?? [];
      setDocuments(next);
      setSelectedDocumentId((current) => (next.find((doc) => doc.id === current)?.id ?? next[0]?.id ?? ""));
    }

    void load();
  }, []);

  const selectedDocument = useMemo(
    () => documents.find((doc) => doc.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );

  return {
    documents,
    selectedDocumentId,
    selectedDocument,
    setSelectedDocumentId,
    loadError: error,
  };
}

function DocumentPicker({
  label,
  documents,
  selectedDocumentId,
  onChange,
  excludeId,
}: {
  label: string;
  documents: DocumentRecord[];
  selectedDocumentId: string;
  onChange: (value: string) => void;
  excludeId?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-slate-700">{label}</span>
      <select
        value={selectedDocumentId}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
      >
        {!documents.length ? <option value="">No documents available</option> : null}
        {documents
          .filter((doc) => doc.id !== excludeId)
          .map((document) => (
            <option key={document.id} value={document.id}>
              {document.name}
            </option>
          ))}
      </select>
    </label>
  );
}

export function OcrConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OcrResult | null>(null);

  async function runOcr() {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/ocr/${selectedDocumentId}`, { method: "POST" }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as OcrPayload | null;
    if (!response?.ok || !data?.ocr) {
      setError(data?.error ?? "OCR could not be completed.");
      setBusy(false);
      return;
    }
    setResult(data.ocr);
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="OCR"
        description="Run OCR on a selected document and review extracted text immediately."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="OCR Workspace" description="Select a document, run OCR, then inspect confidence and extracted text.">
          <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <ScanText className="h-4 w-4" />
                OCR
              </div>
              <DocumentPicker label="Document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} />
              <button
                type="button"
                onClick={() => void runOcr()}
                disabled={!selectedDocumentId || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Running OCR..." : "Run OCR"}
              </button>
              {selectedDocument ? (
                <p className="text-xs font-semibold text-slate-500">
                  {statusLabel(selectedDocument.status)} · {bytes(selectedDocument.sizeBytes)}
                </p>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>{result ? "OCR completed" : "Awaiting OCR"}</StatusPill>
                {result ? <StatusPill>{Math.round(result.confidence)}% confidence</StatusPill> : null}
              </div>
              {result ? (
                <>
                  <p className="text-xs font-semibold text-slate-500">Language: {result.language} · {niceDate(result.createdAt)}</p>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-700">{result.text}</pre>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href="/documents" className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                      Open Documents
                    </Link>
                    {selectedDocument ? (
                      <Link href={`/documents/${selectedDocument.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                        Open Document
                      </Link>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-500">Run OCR to view extracted text output.</p>
              )}
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

export function ExtractionConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExtractionResult | null>(null);

  async function runExtraction() {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/extractions/${selectedDocumentId}`, { method: "POST" }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as ExtractionPayload | null;
    if (!response?.ok || !data?.extraction) {
      setError(data?.error ?? "Extraction could not be completed.");
      setBusy(false);
      return;
    }
    setResult(data.extraction);
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="Extraction"
        description="Extract structured fields and line items from a selected document."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="Extraction Workspace" description="Run extraction and review fields in the same screen.">
          <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <FileSearch className="h-4 w-4" />
                Extraction
              </div>
              <DocumentPicker label="Document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} />
              <button
                type="button"
                onClick={() => void runExtraction()}
                disabled={!selectedDocumentId || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Extracting..." : "Run Extraction"}
              </button>
              {selectedDocument ? (
                <p className="text-xs font-semibold text-slate-500">{statusLabel(selectedDocument.status)} · {selectedDocument.detectedType}</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>{result ? "Extraction completed" : "Awaiting extraction"}</StatusPill>
                {result ? <StatusPill>{Math.round(result.confidence)}% confidence</StatusPill> : null}
              </div>
              {result ? (
                <>
                  <p className="text-xs font-semibold text-slate-500">Detected type: {result.detectedType} · {niceDate(result.createdAt)}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {Object.entries(result.fields).slice(0, 12).map(([key, value]) => (
                      <div key={key} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">{key}</p>
                        <p className="mt-1 truncate text-sm font-semibold text-slate-700">{String(value ?? "-")}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs font-semibold text-slate-500">Line items: {result.lineItems.length}</p>
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-500">Run extraction to view detected fields and line items.</p>
              )}
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

export function SummariesConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [prompt, setPrompt] = useState("Summarize this document for an operations manager in bullet points.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InsightResult | null>(null);

  async function runSummary() {
    if (!selectedDocumentId || !prompt.trim()) return;
    setBusy(true);
    setError("");
    const response = await fetch(`/api/ai/${selectedDocumentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
    }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as InsightPayload | null;
    if (!response?.ok || !data?.insight) {
      setError(data?.error ?? "Summary generation failed.");
      setBusy(false);
      return;
    }
    setResult(data.insight);
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="Summaries"
        description="Generate actionable summaries from document content using your AI endpoint."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="Summary Workspace" description="Select a document, provide a prompt, and generate a summary.">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <WandSparkles className="h-4 w-4" />
                Summaries
              </div>
              <DocumentPicker label="Document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} />
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">Prompt</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="min-h-32 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
                />
              </label>
              <button
                type="button"
                onClick={() => void runSummary()}
                disabled={!selectedDocumentId || !prompt.trim() || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Generating..." : "Generate Summary"}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>{result ? "Summary ready" : "Awaiting request"}</StatusPill>
                {result ? <StatusPill>{Math.round(result.confidence)}% confidence</StatusPill> : null}
              </div>
              {result ? (
                <>
                  <p className="text-xs font-semibold text-slate-500">Generated: {niceDate(result.createdAt)}</p>
                  <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{result.answer}</div>
                  {selectedDocument ? (
                    <Link href={`/documents/${selectedDocument.id}`} className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                      Open Document
                    </Link>
                  ) : null}
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-500">Generate a summary to view output here.</p>
              )}
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

export function CompareConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [rightDocumentId, setRightDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (!documents.length) return;
    setRightDocumentId((current) => {
      if (current && current !== selectedDocumentId && documents.some((doc) => doc.id === current)) return current;
      return documents.find((doc) => doc.id !== selectedDocumentId)?.id ?? "";
    });
  }, [documents, selectedDocumentId]);

  const rightDocument = useMemo(() => documents.find((doc) => doc.id === rightDocumentId) ?? null, [documents, rightDocumentId]);

  async function compareDocuments() {
    if (!selectedDocumentId || !rightDocumentId) return;
    setBusy(true);
    setError("");

    const [leftExtractionResponse, rightExtractionResponse] = await Promise.all([
      fetch(`/api/extractions/${selectedDocumentId}`, { method: "POST" }).catch(() => null),
      fetch(`/api/extractions/${rightDocumentId}`, { method: "POST" }).catch(() => null),
    ]);

    const leftData = (await leftExtractionResponse?.json().catch(() => null)) as ExtractionPayload | null;
    const rightData = (await rightExtractionResponse?.json().catch(() => null)) as ExtractionPayload | null;

    if (!leftExtractionResponse?.ok || !rightExtractionResponse?.ok || !leftData?.extraction || !rightData?.extraction) {
      setError("Comparison could not be completed for the selected documents.");
      setBusy(false);
      return;
    }

    const leftExtraction = leftData.extraction;
    const rightExtraction = rightData.extraction;
    const leftKeys = Object.keys(leftExtraction.fields);
    const rightKeys = Object.keys(rightExtraction.fields);
    const sharedKeys = leftKeys.filter((key) => rightKeys.includes(key));
    const valueChanges = sharedKeys.filter((key) => String(leftExtraction.fields[key]) !== String(rightExtraction.fields[key]));

    setSummary(
      `${sharedKeys.length} shared fields found. ${valueChanges.length} fields have different values. Left line items: ${leftExtraction.lineItems.length}, Right line items: ${rightExtraction.lineItems.length}.`,
    );
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="Compare"
        description="Compare two documents by extracted fields and line-item volume in one workflow."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="Comparison Workspace" description="Pick two documents and compare their extracted datasets.">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <Columns3 className="h-4 w-4" />
                Compare
              </div>
              <DocumentPicker label="Left document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} excludeId={rightDocumentId} />
              <DocumentPicker label="Right document" documents={documents} selectedDocumentId={rightDocumentId} onChange={setRightDocumentId} excludeId={selectedDocumentId} />
              <button
                type="button"
                onClick={() => void compareDocuments()}
                disabled={!selectedDocumentId || !rightDocumentId || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Comparing..." : "Compare Documents"}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">Left</p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">{selectedDocument?.name ?? "-"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">Right</p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">{rightDocument?.name ?? "-"}</p>
                </div>
              </div>
              {summary ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm font-semibold text-slate-700">{summary}</p> : <p className="mt-3 text-sm font-semibold text-slate-500">Run comparison to view differences.</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedDocument ? (
                  <Link href={`/documents/${selectedDocument.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                    Open Left
                  </Link>
                ) : null}
                {rightDocument ? (
                  <Link href={`/documents/${rightDocument.id}`} className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                    Open Right
                  </Link>
                ) : null}
              </div>
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

export function TranslateConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [targetLanguage, setTargetLanguage] = useState("Spanish");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InsightResult | null>(null);

  async function runTranslation() {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError("");
    const prompt = `Translate this document into ${targetLanguage}. Keep financial and legal terminology precise and return a clean translated output.`;
    const response = await fetch(`/api/ai/${selectedDocumentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as InsightPayload | null;
    if (!response?.ok || !data?.insight) {
      setError(data?.error ?? "Translation could not be completed.");
      setBusy(false);
      return;
    }
    setResult(data.insight);
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="Translate"
        description="Generate translated document output through the AI workflow for the selected language."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="Translation Workspace" description="Select a document and target language, then run translation.">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <Languages className="h-4 w-4" />
                Translate
              </div>
              <DocumentPicker label="Document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} />
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">Target language</span>
                <select
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value)}
                  className="min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
                >
                  <option>Spanish</option>
                  <option>French</option>
                  <option>Portuguese</option>
                  <option>German</option>
                  <option>Afrikaans</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => void runTranslation()}
                disabled={!selectedDocumentId || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Translating..." : "Translate"}
              </button>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>{result ? "Translated output ready" : "Awaiting translation"}</StatusPill>
              </div>
              {result ? (
                <>
                  <p className="text-xs font-semibold text-slate-500">{niceDate(result.createdAt)}</p>
                  <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{result.answer}</div>
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-500">Run translation to generate output.</p>
              )}
              {selectedDocument ? (
                <Link href={`/documents/${selectedDocument.id}`} className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                  Open Document
                </Link>
              ) : null}
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

export function RedactConsole() {
  const { documents, selectedDocumentId, selectedDocument, setSelectedDocumentId, loadError } = useDocuments();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InsightResult | null>(null);

  async function runRedactionScan() {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError("");
    const prompt = "Identify sensitive fields in this document and provide a redaction plan with exact field types to hide before sharing.";
    const response = await fetch(`/api/ai/${selectedDocumentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).catch(() => null);
    const data = (await response?.json().catch(() => null)) as InsightPayload | null;
    if (!response?.ok || !data?.insight) {
      setError(data?.error ?? "Redaction scan failed.");
      setBusy(false);
      return;
    }
    setResult(data.insight);
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        eyebrow="Convert Files"
        title="Redact"
        description="Scan for sensitive content and generate a redaction plan from your selected document."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title="Redaction Workspace" description="Run a redaction scan and review suggested sensitive fields.">
          <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-black text-royal-700 ring-1 ring-slate-200">
                <PencilLine className="h-4 w-4" />
                Redact
              </div>
              <DocumentPicker label="Document" documents={documents} selectedDocumentId={selectedDocumentId} onChange={setSelectedDocumentId} />
              <button
                type="button"
                onClick={() => void runRedactionScan()}
                disabled={!selectedDocumentId || busy}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-royal-600 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                {busy ? "Scanning..." : "Scan for Sensitive Fields"}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>{result ? "Redaction plan ready" : "Awaiting scan"}</StatusPill>
              </div>
              {result ? (
                <>
                  <p className="text-xs font-semibold text-slate-500">{niceDate(result.createdAt)}</p>
                  <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{result.answer}</div>
                </>
              ) : (
                <p className="text-sm font-semibold text-slate-500">Run a scan to produce redaction suggestions.</p>
              )}
              {selectedDocument ? (
                <Link href={`/documents/${selectedDocument.id}`} className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
                  Open Document
                </Link>
              ) : null}
              {loadError || error ? <p className="mt-3 text-sm font-semibold text-rose-600">{error || loadError}</p> : null}
            </div>
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

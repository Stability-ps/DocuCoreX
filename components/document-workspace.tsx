"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Download, FileJson, FileSpreadsheet, MessageSquareText, Send, ScanText } from "lucide-react";
import { PdfViewer } from "@/components/pdf-viewer";
import {
  comments,
  documents,
  extractionModules,
  historyEvents,
  ocrLines,
  workspaceTabs,
} from "@/lib/product-data";
import { SectionPanel, StatusPill } from "@/components/ui";
import type {
  AiInsight,
  DocumentComment,
  DocumentDownload,
  DocumentRecord,
  DocumentVersion,
  ExtractionResult,
  OcrResult,
  ProcessingJob,
} from "@/lib/types";

type WorkspaceData = {
  document?: DocumentRecord;
  jobs: ProcessingJob[];
  ocr?: OcrResult;
  extraction?: ExtractionResult;
  insights?: AiInsight[];
  comments?: DocumentComment[];
  downloads?: DocumentDownload[];
  versions?: DocumentVersion[];
};

function formatBytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function titleCase(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function DocumentWorkspace({ documentId }: { documentId: string }) {
  const fallbackDoc = useMemo(() => documents.find((item) => item.id === documentId) ?? documents[0], [documentId]);
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData>({ jobs: [] });
  const [tab, setTab] = useState("Overview");
  const [workflowStatus, setWorkflowStatus] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "not_found" | "error">("loading");

  useEffect(() => {
    async function loadWorkspace() {
      setLoadState("loading");
      const [documentResponse, ocrResponse, extractionResponse] = await Promise.all([
        fetch(`/api/documents/${documentId}`),
        fetch(`/api/ocr/${documentId}`),
        fetch(`/api/extractions/${documentId}`),
      ]);

      const nextData: WorkspaceData = { jobs: [] };

      if (documentResponse.ok) {
        const data = (await documentResponse.json()) as { document: DocumentRecord; jobs: ProcessingJob[] };
        nextData.document = data.document;
        nextData.jobs = data.jobs;
      } else if (documentResponse.status === 404) {
        setLoadState("not_found");
        return;
      } else {
        setLoadState("error");
        return;
      }

      if (ocrResponse.ok) {
        const data = (await ocrResponse.json()) as { ocr?: OcrResult };
        nextData.ocr = data.ocr;
      }

      if (extractionResponse.ok) {
        const data = (await extractionResponse.json()) as { extraction?: ExtractionResult };
        nextData.extraction = data.extraction;
      }

      setWorkspaceData(nextData);
      setLoadState("ready");
    }

    void loadWorkspace();
  }, [documentId]);

  async function refreshWorkspacePanels() {
    const [commentsResponse, downloadsResponse, aiResponse, historyResponse] = await Promise.all([
      fetch(`/api/comments/${documentId}`),
      fetch(`/api/downloads/${documentId}`),
      fetch(`/api/ai/${documentId}`),
      fetch(`/api/history/${documentId}`),
    ]);

    setWorkspaceData((current) => ({
      ...current,
      comments: commentsResponse.ok ? undefined : current.comments,
      downloads: downloadsResponse.ok ? undefined : current.downloads,
      insights: aiResponse.ok ? undefined : current.insights,
    }));

    const [commentsData, downloadsData, aiData, historyData] = await Promise.all([
      commentsResponse.ok ? commentsResponse.json() : Promise.resolve({ comments: workspaceData.comments }),
      downloadsResponse.ok ? downloadsResponse.json() : Promise.resolve({ downloads: workspaceData.downloads }),
      aiResponse.ok ? aiResponse.json() : Promise.resolve({ insights: workspaceData.insights }),
      historyResponse.ok ? historyResponse.json() : Promise.resolve({ versions: workspaceData.versions }),
    ]);

    setWorkspaceData((current) => ({
      ...current,
      comments: commentsData.comments,
      downloads: downloadsData.downloads,
      insights: aiData.insights,
      versions: historyData.versions,
    }));
  }

  useEffect(() => {
    void refreshWorkspacePanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  async function runOcr() {
    setWorkflowStatus("Running OCR…");
    const response = await fetch(`/api/ocr/${documentId}`, { method: "POST" });

    if (!response.ok) {
      setWorkflowStatus("OCR failed");
      return;
    }

    const data = (await response.json()) as { ocr?: OcrResult; job?: ProcessingJob };
    setWorkspaceData((current) => ({
      ...current,
      ocr: data.ocr ?? current.ocr,
      jobs: data.job ? [data.job, ...current.jobs.filter((job) => job.id !== data.job?.id)] : current.jobs,
    }));
    setWorkflowStatus("OCR completed");
  }

  async function runExtraction() {
    setWorkflowStatus("Running extraction…");
    const response = await fetch(`/api/extractions/${documentId}`, { method: "POST" });

    if (!response.ok) {
      setWorkflowStatus("Extraction failed");
      return;
    }

    const data = (await response.json()) as { extraction?: ExtractionResult; job?: ProcessingJob };
    setWorkspaceData((current) => ({
      ...current,
      extraction: data.extraction ?? current.extraction,
      jobs: data.job ? [data.job, ...current.jobs.filter((job) => job.id !== data.job?.id)] : current.jobs,
    }));
    setWorkflowStatus("Extraction completed");
  }

  const doc = workspaceData.document;
  const displayName = doc?.name ?? fallbackDoc.name;
  const displayStatus = doc ? titleCase(doc.status) : fallbackDoc.status;
  const displayType = doc ? titleCase(doc.detectedType) : fallbackDoc.type;
  const displayPages = doc?.pageCount ?? fallbackDoc.pages;
  const displaySize = doc ? formatBytes(doc.sizeBytes) : fallbackDoc.size;

  if (loadState === "loading") {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="font-black text-navy-950">Loading document workspace</p>
          <p className="mt-2 text-sm text-slate-500">Retrieving metadata, jobs, OCR and extraction panels.</p>
        </div>
      </div>
    );
  }

  if (loadState === "not_found" || loadState === "error") {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="font-black text-navy-950">{loadState === "not_found" ? "Document not found" : "Unable to load document"}</p>
          <p className="mt-2 text-sm text-slate-500">The file may have been deleted, moved to another workspace, or your role may not have access.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="mb-3 flex flex-wrap gap-2">
              <StatusPill>{displayStatus}</StatusPill>
              <StatusPill>{displayType}</StatusPill>
              <StatusPill>{displayPages} pages</StatusPill>
            </div>
            <h1 className="text-3xl font-black text-navy-950">{displayName}</h1>
            <p className="mt-2 text-sm text-slate-500">
              Owned by {doc?.ownerId ?? fallbackDoc.owner} • Updated {doc ? new Date(doc.updatedAt).toLocaleString() : fallbackDoc.updated} • {displaySize}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-600 shadow-sm">Share</button>
            <a href="/api/download-file/download_xlsx_statement_q2" className="rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">Download</a>
          </div>
        </div>
        {workflowStatus ? <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-600">{workflowStatus}</p> : null}
        <div className="mt-6 flex gap-2 overflow-x-auto border-b border-slate-100 pb-2">
          {workspaceTabs.map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-black transition ${
                tab === item ? "bg-royal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-royal-50 hover:text-royal-700"
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      {tab === "Overview" ? <OverviewTab data={workspaceData} /> : null}
      {tab === "Preview" ? <PdfViewer /> : null}
      {tab === "OCR" ? <OcrTab ocr={workspaceData.ocr} onRun={runOcr} /> : null}
      {tab === "Extracted Data" ? <ExtractionTab extraction={workspaceData.extraction} onRun={runExtraction} /> : null}
      {tab === "AI Analysis" ? <AiTab documentId={documentId} insights={workspaceData.insights} onInsight={refreshWorkspacePanels} /> : null}
      {tab === "History" ? <HistoryTab versions={workspaceData.versions} /> : null}
      {tab === "Comments" ? <CommentsTab comments={workspaceData.comments} documentId={documentId} onComment={refreshWorkspacePanels} /> : null}
      {tab === "Downloads" ? <DownloadsTab downloads={workspaceData.downloads} /> : null}
    </div>
  );
}

function OverviewTab({ data }: { data: WorkspaceData }) {
  const detectedType = data.extraction?.detectedType ?? data.document?.detectedType ?? "bank_statement";
  const confidence = data.extraction?.confidence ?? data.ocr?.confidence ?? 98.7;
  const language = data.ocr?.language ?? "en";

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
      <SectionPanel title="Document Intelligence Summary" description="Automatic type detection, OCR quality, extraction readiness and workflow state.">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ["Document Type", titleCase(detectedType)],
            ["Confidence Score", `${confidence}%`],
            ["Language Detected", language.toUpperCase()],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
              <p className="mt-2 text-xl font-black text-navy-950">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-2xl border border-royal-100 bg-royal-50 p-4 text-sm leading-6 text-navy-900">
          DocuCoreX detected a financial document with transaction tables, recurring payments, VAT-tagged items and duplicate payment candidates.
        </div>
      </SectionPanel>
      <SectionPanel title="Processing Pipeline" description="Background jobs update as the file moves through the workspace.">
        <div className="space-y-3">
          {(data.jobs.length ? data.jobs : []).map((job) => (
            <div key={job.id} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-4">
              <CheckCircle2 className={`h-5 w-5 ${job.status === "completed" ? "text-emerald-500" : "text-amber-500"}`} />
              <span className="font-black capitalize text-navy-950">{job.type.replace("_", " ")}</span>
              <span className="ml-auto text-sm font-bold capitalize text-slate-500">{job.status}</span>
            </div>
          ))}
          {data.jobs.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-500">No processing jobs are attached yet.</div>
          ) : null}
        </div>
      </SectionPanel>
    </div>
  );
}

function OcrTab({ ocr, onRun }: { ocr?: OcrResult; onRun: () => Promise<void> }) {
  const extractedLines = ocr?.text ? ocr.text.split("\n") : ocrLines;
  const confidence = ocr?.confidence ?? 98.7;
  const language = ocr?.language ?? "en";

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <SectionPanel title="OCR Processing" description="The architecture tracks extraction stages, confidence, language and layout analysis.">
        <div className="space-y-4">
          <button onClick={onRun} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">
            <ScanText className="h-4 w-4" />
            Run OCR
          </button>
          {[
            ["Processing…", 100],
            ["Extracting text…", 100],
            ["Analysing layout…", 86],
          ].map(([label, progress]) => (
            <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between text-sm font-black">
                <span className="text-navy-950">{label}</span>
                <span className="text-royal-700">{progress}%</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-white">
                <div className="h-full rounded-full bg-royal-600" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-emerald-50 p-4">
              <p className="text-sm font-black text-emerald-700">Confidence score</p>
              <p className="mt-1 text-3xl font-black text-emerald-800">{confidence}%</p>
            </div>
            <div className="rounded-2xl bg-royal-50 p-4">
              <p className="text-sm font-black text-royal-700">Language detected</p>
              <p className="mt-1 text-3xl font-black text-royal-800">{language.toUpperCase()}</p>
            </div>
          </div>
        </div>
      </SectionPanel>
      <SectionPanel title="Extracted Text Side Panel" description="Searchable OCR output ready for copying, review and downstream extraction.">
        <div className="space-y-3">
          {extractedLines.map((line) => (
            <div key={line} className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm font-semibold text-navy-900">
              {line}
            </div>
          ))}
        </div>
      </SectionPanel>
    </div>
  );
}

function ExtractionTab({ extraction, onRun }: { extraction?: ExtractionResult; onRun: () => Promise<void> }) {
  return (
    <SectionPanel title="Automatic Extraction Modules" description="DocuCoreX detects document types automatically and routes each file to the right extraction model.">
      <button onClick={onRun} className="mb-5 inline-flex items-center justify-center gap-2 rounded-2xl bg-royal-600 px-4 py-3 text-sm font-black text-white shadow-glow">
        <FileSpreadsheet className="h-4 w-4" />
        Run Extraction
      </button>
      {extraction ? (
        <div className="mb-5 rounded-2xl border border-royal-100 bg-royal-50 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.14em] text-royal-700">Detected result</p>
              <h3 className="mt-2 text-2xl font-black text-navy-950">{titleCase(extraction.detectedType)}</h3>
              <p className="mt-1 text-sm font-bold text-slate-600">{extraction.confidence}% confidence</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(extraction.fields).slice(0, 6).map(([key, value]) => (
                <div key={key} className="rounded-xl bg-white px-3 py-2">
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">{titleCase(key)}</p>
                  <p className="text-sm font-black text-navy-950">{String(value)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {extractionModules.map((module) => (
          <article key={module.title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <module.icon className="h-6 w-6 text-royal-600" />
            <h3 className="mt-4 font-black text-navy-950">{module.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">{module.fields}</p>
            <div className="mt-4 h-2 rounded-full bg-white">
              <div className="h-full rounded-full bg-royal-600" style={{ width: `${module.confidence}%` }} />
            </div>
            <p className="mt-2 text-xs font-black text-royal-700">{module.confidence}% model confidence</p>
          </article>
        ))}
      </div>
    </SectionPanel>
  );
}

function AiTab({
  documentId,
  insights,
  onInsight,
}: {
  documentId: string;
  insights?: AiInsight[];
  onInsight: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState(insights?.[0]?.answer ?? "");
  const [isAsking, setIsAsking] = useState(false);

  async function ask(prompt: string) {
    setIsAsking(true);
    const response = await fetch(`/api/ai/${documentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (response.ok) {
      const data = (await response.json()) as { insight: AiInsight };
      setAnswer(data.insight.answer);
      await onInsight();
    }

    setIsAsking(false);
  }

  const primaryInsight = answer || insights?.[0]?.answer || "Ask a question to generate an AI analysis for this document.";

  return (
    <div className="grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
      <SectionPanel title="Ask DocuCoreX AI" description="Question the document and generate finance-focused answers.">
        <div className="space-y-3">
          {["Show all fuel expenses.", "Export VAT transactions.", "Find duplicate payments.", "Generate monthly cash flow."].map((prompt) => (
            <button
              key={prompt}
              onClick={() => ask(prompt)}
              className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left text-sm font-black text-navy-950 hover:border-royal-200 hover:bg-white"
            >
              <Bot className="h-5 w-5 text-royal-600" />
              {prompt}
            </button>
          ))}
        </div>
      </SectionPanel>
      <SectionPanel title="AI Analysis" description="Summaries, risk flags and unusual transaction explanations appear here.">
        <div className="rounded-2xl bg-navy-950 p-5 text-white navy-grid">
          <p className="text-sm font-black text-sky-300">Insight generated</p>
          <p className="mt-3 text-lg font-bold leading-8">
            {isAsking ? "Analysing document…" : primaryInsight}
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {(insights ?? []).map((insight) => (
            <div key={insight.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="font-black text-navy-950">{insight.prompt}</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">{insight.answer}</p>
            </div>
          ))}
        </div>
      </SectionPanel>
    </div>
  );
}

function HistoryTab({ versions }: { versions?: DocumentVersion[] }) {
  return (
    <SectionPanel title="Version History" description="Document events, processing history and version lineage.">
      <div className="space-y-3">
        {(versions ?? []).map((version) => (
          <div key={version.id} className="flex items-center gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-royal-600 text-sm font-black text-white">{version.versionNumber}</div>
            <div>
              <p className="font-black text-navy-950">{version.changeNote}</p>
              <p className="text-sm text-slate-500">{version.storagePath}</p>
            </div>
            <p className="ml-auto text-sm text-slate-500">{new Date(version.createdAt).toLocaleDateString()}</p>
          </div>
        ))}
        {!versions?.length
          ? historyEvents.map((event, index) => (
              <div key={event} className="flex items-center gap-4 rounded-2xl bg-slate-50 p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-royal-600 text-sm font-black text-white">{index + 1}</div>
                <p className="font-black text-navy-950">{event}</p>
                <p className="ml-auto text-sm text-slate-500">Today</p>
              </div>
            ))
          : null}
      </div>
    </SectionPanel>
  );
}

function CommentsTab({
  comments: apiComments,
  documentId,
  onComment,
}: {
  comments?: DocumentComment[];
  documentId: string;
  onComment: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const visibleComments =
    apiComments ??
    comments.map((comment, index) => ({
      id: `fallback_${index}`,
      documentId,
      authorName: comment.name,
      body: comment.body,
      createdAt: new Date().toISOString(),
    }));

  async function submitComment() {
    if (!body.trim()) return;
    const response = await fetch(`/api/comments/${documentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, authorName: "Patric" }),
    });

    if (response.ok) {
      setBody("");
      await onComment();
    }
  }

  return (
    <SectionPanel title="Comments" description="Collaborate with finance, audit and operations teams inside the document workspace.">
      <div className="space-y-3">
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:flex-row">
          <input
            className="min-h-12 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold outline-none focus:border-royal-300"
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a comment for the team"
            value={body}
          />
          <button onClick={submitComment} className="inline-flex items-center justify-center gap-2 rounded-xl bg-royal-600 px-4 py-3 text-sm font-black text-white">
            <Send className="h-4 w-4" />
            Comment
          </button>
        </div>
        {visibleComments.map((comment) => (
          <div key={comment.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-royal-600 text-sm font-black text-white">{comment.authorName[0]}</div>
              <p className="font-black text-navy-950">{comment.authorName}</p>
              <p className="ml-auto text-sm text-slate-500">{new Date(comment.createdAt).toLocaleTimeString()}</p>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-600">{comment.body}</p>
          </div>
        ))}
      </div>
    </SectionPanel>
  );
}

function DownloadsTab({ downloads }: { downloads?: DocumentDownload[] }) {
  const visibleDownloads =
    downloads ??
    ([
      { id: "fallback_xlsx", label: "Excel workbook", format: "xlsx", status: "ready", href: "#", documentId: "fallback", createdAt: new Date().toISOString() },
      { id: "fallback_json", label: "JSON payload", format: "json", status: "ready", href: "#", documentId: "fallback", createdAt: new Date().toISOString() },
      { id: "fallback_txt", label: "OCR text file", format: "txt", status: "ready", href: "#", documentId: "fallback", createdAt: new Date().toISOString() },
    ] as DocumentDownload[]);

  const iconByFormat = {
    xlsx: FileSpreadsheet,
    json: FileJson,
    txt: ScanText,
    pdf: Download,
    csv: FileSpreadsheet,
  };

  return (
    <SectionPanel title="Downloads" description="Export structured data and document artifacts when processing completes.">
      <div className="grid gap-4 sm:grid-cols-3">
        {visibleDownloads.map((download) => {
          const Icon = iconByFormat[download.format];
          return (
          <a key={download.id} href={download.href} className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-left hover:bg-white hover:shadow-sm">
            <Icon className="h-6 w-6 text-royal-600" />
            <p className="mt-4 font-black text-navy-950">{download.label}</p>
            <p className="mt-1 text-sm capitalize text-slate-500">{download.status} • {download.format}</p>
            <Download className="mt-4 h-5 w-5 text-slate-400" />
          </a>
        )})}
      </div>
    </SectionPanel>
  );
}

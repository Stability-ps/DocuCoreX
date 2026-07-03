"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Archive,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderUp,
  Pause,
  Play,
  RefreshCcw,
  Save,
  Trash2,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import { BulkActionToolbar, MobileBulkBar, SelectionCheckbox, checkboxShiftKey, useBulkSelection } from "@/components/bulk-selection";

type ConversionTarget = "pdf" | "word" | "excel" | "images" | "zip";
type UploadStatus = "queued" | "uploading" | "uploaded" | "failed" | "cancelled" | "paused";
type ConversionStatus = "none" | "ready" | "queued" | "converting" | "completed" | "failed" | "cancelled";

type QueueItem = {
  id: string;
  documentId?: string;
  conversionId?: string;
  name: string;
  size: number;
  mimeType: string;
  uploadStatus: UploadStatus;
  conversionStatus: ConversionStatus;
  uploadProgress: number;
  conversionProgress: number;
  stage: string;
  speedBps?: number;
  startedAt: number;
  updatedAt: number;
  etaSeconds?: number;
  elapsedSeconds: number;
  error?: string;
  file?: File;
  downloadUrl?: string;
  outputReady?: boolean;
  targetFormat?: ConversionTarget;
  savedToLibrary?: boolean;
};

type WorkflowItem = {
  documentId: string;
  name: string;
  mimeType: string;
  size: number;
  uploadStatus: UploadStatus;
  conversionStatus: ConversionStatus;
  stage: string;
  outputReady?: boolean;
  uploadProgress: number;
  conversionProgress: number;
  conversion?: { id: string; to: string; status: string; outputReady?: boolean; downloadUrl?: string | null } | null;
};

const storageKey = "docucorex.uploadQueue.v2";
const removedKey = "docucorex.removedUploadDocuments";

const supportedExtensions = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".csv",
  ".rtf",
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
  ".bmp",
  ".gif",
  ".heic",
  ".zip",
];

const conversionTargets: Array<{
  id: ConversionTarget;
  title: string;
  icon: React.ElementType;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
}> = [
  { id: "pdf", title: "PDF", icon: FileText, description: "Convert Office files, text files and images into a generated PDF." },
  { id: "word", title: "Word", icon: FileType2, description: "Extract readable document text into an editable DOCX file." },
  { id: "excel", title: "Excel", icon: FileSpreadsheet, description: "Extract readable text and table-like content into XLSX worksheets." },
  {
    id: "images",
    title: "Images",
    icon: FileImage,
    description: "Export document pages as PNG or JPG.",
    disabled: true,
    disabledReason: "Requires a PDF/image rendering provider before page export can run.",
  },
  { id: "zip", title: "ZIP", icon: FileArchive, description: "Bundle processed results into a ZIP archive." },
];

function formatBytes(bytes?: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function statusTone(status: UploadStatus | ConversionStatus) {
  if (status === "completed" || status === "uploaded" || status === "ready") return "bg-emerald-50 text-emerald-700 border-emerald-100";
  if (status === "failed") return "bg-rose-50 text-rose-700 border-rose-100";
  if (status === "cancelled") return "bg-slate-100 text-slate-500 border-slate-200";
  if (status === "paused") return "bg-amber-50 text-amber-700 border-amber-100";
  return "bg-royal-50 text-royal-700 border-royal-100";
}

function readRemovedIds() {
  try {
    return new Set<string>(JSON.parse(window.localStorage.getItem(removedKey) || "[]") as string[]);
  } catch {
    return new Set<string>();
  }
}

function rememberRemovedId(id?: string) {
  if (!id) return;
  const removed = readRemovedIds();
  removed.add(id);
  window.localStorage.setItem(removedKey, JSON.stringify(Array.from(removed)));
}

function serializeQueue(items: QueueItem[]) {
  return items.map(({ file: _file, ...item }) => item).filter((item) => item.uploadStatus !== "cancelled" && item.conversionStatus !== "cancelled");
}

function visibleProgress(item: QueueItem) {
  if (item.uploadStatus === "uploading") return item.uploadProgress;
  if (item.uploadStatus === "uploaded" && item.conversionStatus === "none") return 100;
  if (item.conversionStatus === "ready") return 100;
  if (item.conversionStatus === "completed") return 100;
  if (item.conversionStatus === "converting" || item.conversionStatus === "queued") return item.conversionProgress;
  if (item.uploadStatus === "failed") return item.uploadProgress || 1;
  if (item.conversionStatus === "failed") return item.conversionProgress || 1;
  return item.uploadProgress;
}

function primaryStatus(item: QueueItem) {
  if (item.uploadStatus !== "uploaded") return item.uploadStatus;
  if (item.conversionStatus === "none" || item.conversionStatus === "ready") return "Uploaded";
  if (item.conversionStatus === "queued") return "Queued";
  if (item.conversionStatus === "converting") return "Converting";
  if (item.conversionStatus === "completed") return "Completed";
  if (item.conversionStatus === "failed") return "Failed";
  return "Uploaded";
}

function secondaryStatus(item: QueueItem) {
  if (item.uploadStatus === "uploading") return "Uploading";
  if (item.uploadStatus === "uploaded" && (item.conversionStatus === "none" || item.conversionStatus === "ready")) return "Ready to convert";
  if (item.conversionStatus === "completed") return "Download ready";
  if (item.conversionStatus === "converting" || item.conversionStatus === "queued") return `${item.stage} ${item.conversionProgress}%`;
  if (item.uploadStatus === "failed" || item.conversionStatus === "failed") return item.error ?? "Failed";
  return item.stage;
}

function mapWorkflowStatus(item: WorkflowItem): QueueItem {
  return {
    id: item.documentId,
    documentId: item.documentId,
    conversionId: item.conversion?.id,
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
    uploadStatus: item.uploadStatus,
    conversionStatus: item.conversionStatus,
    uploadProgress: item.uploadProgress,
    conversionProgress: item.conversionProgress,
    stage: item.stage,
    speedBps: undefined,
    etaSeconds: undefined,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    elapsedSeconds: 0,
    error: item.conversionStatus === "failed" ? item.stage : undefined,
    outputReady: item.outputReady || Boolean(item.conversion?.outputReady),
    downloadUrl: item.outputReady || item.conversion?.outputReady ? item.conversion?.downloadUrl ?? undefined : undefined,
    targetFormat: item.conversion?.to as ConversionTarget | undefined,
    savedToLibrary: true,
  };
}

export function UploadCenter({ workflow }: { workflow?: string }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [target, setTarget] = useState<ConversionTarget | null>(workflow === "scan_document" ? "word" : null);
  const [dragActive, setDragActive] = useState(false);
  const [message, setMessage] = useState("Ready to upload");
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const requestsRef = useRef<Record<string, XMLHttpRequest>>({});

  const activeItems = items.filter((item) => item.uploadStatus !== "cancelled" && item.conversionStatus !== "cancelled");
  const selection = useBulkSelection(activeItems);
  const readyToConvertItems = activeItems.filter((item) => item.documentId && item.uploadStatus === "uploaded" && (item.conversionStatus === "none" || item.conversionStatus === "ready"));
  const completedConversions = activeItems.filter((item) => item.conversionId && item.conversionStatus === "completed" && item.outputReady && item.downloadUrl);
  const latestReadyItem = readyToConvertItems[0] ?? null;
  const shouldRecommendAccounting = useMemo(() => {
    if (!latestReadyItem) return false;
    const text = `${latestReadyItem.name} ${latestReadyItem.mimeType}`.toLowerCase();
    return ["statement", "invoice", "receipt", "supplier", "financial report", "bank"].some((token) => text.includes(token));
  }, [latestReadyItem]);
  const totalProgress = useMemo(
    () => (activeItems.length ? Math.round(activeItems.reduce((sum, item) => sum + visibleProgress(item), 0) / activeItems.length) : 0),
    [activeItems],
  );

  const refreshWorkflow = useCallback(async () => {
    const response = await fetch("/api/uploads/workflow", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json().catch(() => null)) as { items?: WorkflowItem[] } | null;
    if (!data?.items) return;
    const workflowItems = data.items;

    setItems((current) => {
      const removed = readRemovedIds();
      const byDocument = new Map(current.filter((item) => item.documentId).map((item) => [item.documentId, item]));
      const localOnly = current.filter((item) => !item.documentId && item.file && item.uploadStatus !== "cancelled");
      const remote = workflowItems
        .filter((item) => !removed.has(item.documentId))
        .map((item) => {
          const existing = byDocument.get(item.documentId);
          return {
            ...mapWorkflowStatus(item),
            startedAt: existing?.startedAt ?? Date.now(),
            elapsedSeconds: Math.round((Date.now() - (existing?.startedAt ?? Date.now())) / 1000),
          };
        });
      const merged = [...localOnly, ...remote];
      window.localStorage.setItem(storageKey, JSON.stringify(serializeQueue(merged)));
      return merged;
    });
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) {
      try {
        const removed = readRemovedIds();
        setItems((JSON.parse(stored) as QueueItem[]).filter((item) => !item.documentId || !removed.has(item.documentId)));
      } catch {
        window.localStorage.removeItem(storageKey);
      }
    }
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    void refreshWorkflow();
  }, [refreshWorkflow]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(serializeQueue(items)));
  }, [items]);

  useEffect(() => {
    if (!isProcessing) return;
    const timer = window.setInterval(async () => {
      await fetch("/api/jobs/process", { method: "POST" }).catch(() => null);
      await refreshWorkflow();
    }, 1600);
    return () => window.clearInterval(timer);
  }, [isProcessing, refreshWorkflow]);

  useEffect(() => {
    if (isProcessing && readyToConvertItems.length === 0 && activeItems.some((item) => item.conversionStatus === "completed" || item.conversionStatus === "failed")) {
      setIsProcessing(false);
      setMessage("Processing completed");
    }
  }, [activeItems, isProcessing, readyToConvertItems.length]);

  function isSupported(file: File) {
    const lower = file.name.toLowerCase();
    return supportedExtensions.some((extension) => lower.endsWith(extension));
  }

  function addFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (!selected.length) return;

    selected.forEach((file, index) => {
      const id = `${Date.now()}_${index}_${file.name}`;
      const item: QueueItem = {
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        uploadStatus: isSupported(file) ? "queued" : "failed",
        conversionStatus: "none",
        uploadProgress: 0,
        conversionProgress: 0,
        stage: isSupported(file) ? "Queued" : "Unsupported file type",
        speedBps: undefined,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        elapsedSeconds: 0,
        error: isSupported(file) ? undefined : "Unsupported file type.",
        file,
      };
      setItems((current) => [item, ...current]);
      if (isSupported(file)) uploadItem(item, file);
    });
  }

  function uploadItem(item: QueueItem, file: File) {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    const start = Date.now();
    formData.append("file", file, file.name);
    requestsRef.current[item.id] = xhr;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const elapsed = Math.max(0.1, (Date.now() - start) / 1000);
      const speedBps = event.loaded / elapsed;
      const uploadProgress = Math.round((event.loaded / event.total) * 100);
      const etaSeconds = speedBps ? (event.total - event.loaded) / speedBps : undefined;
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                uploadStatus: "uploading",
                conversionStatus: "none",
                outputReady: false,
                stage: "Uploading",
                uploadProgress,
                speedBps,
                etaSeconds,
                elapsedSeconds: Math.round(elapsed),
                updatedAt: Date.now(),
              }
            : currentItem,
        ),
      );
    };

    xhr.onload = () => {
      delete requestsRef.current[item.id];
      const data = JSON.parse(xhr.responseText || "{}") as {
        accepted?: Array<{ id: string; mimeType: string; size: number; name: string; job?: { id: string } }>;
        error?: string;
      };

      if (xhr.status < 200 || xhr.status >= 300 || !data.accepted?.[0]) {
        setItems((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? { ...currentItem, uploadStatus: "failed", stage: "Failed", uploadProgress: 100, error: data.error ?? "Upload failed", updatedAt: Date.now() }
              : currentItem,
          ),
        );
        return;
      }

      const accepted = data.accepted[0];
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                documentId: accepted.id,
                id: accepted.id,
                mimeType: accepted.mimeType,
                size: accepted.size,
                uploadStatus: "uploaded",
                conversionStatus: "ready",
                outputReady: false,
                stage: "Ready to convert",
                uploadProgress: 100,
                conversionProgress: 0,
                speedBps: undefined,
                etaSeconds: undefined,
                file: undefined,
                savedToLibrary: true,
                updatedAt: Date.now(),
              }
            : currentItem,
        ),
      );
      setMessage(`${accepted.name} uploaded and ready to convert`);
      void refreshWorkflow();
    };

    xhr.onerror = () => {
      delete requestsRef.current[item.id];
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id ? { ...currentItem, uploadStatus: "failed", stage: "Failed", uploadProgress: 100, error: "Network upload failed" } : currentItem,
        ),
      );
    };

    xhr.onabort = () => {
      delete requestsRef.current[item.id];
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id && currentItem.uploadStatus === "uploading"
            ? { ...currentItem, uploadStatus: "paused", stage: "Paused", error: "Upload paused. Resume restarts the upload." }
            : currentItem,
        ),
      );
    };

    xhr.open("POST", "/api/uploads");
    xhr.send(formData);
  }

  function pauseItem(item: QueueItem) {
    requestsRef.current[item.id]?.abort();
  }

  function resumeItem(item: QueueItem) {
    if (!item.file) {
      setMessage("Choose the file again to resume this upload.");
      return;
    }
    uploadItem(item, item.file);
  }

  async function cancelItem(item: QueueItem) {
    requestsRef.current[item.id]?.abort();
    if (item.documentId) rememberRemovedId(item.documentId);
    setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
    if (item.documentId) {
      await fetch("/api/uploads/workflow", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: item.documentId }),
      }).catch(() => null);
    }
  }

  async function removeItem(item: QueueItem) {
    await cancelItem(item);
  }

  async function cancelSelectedItems() {
    const selected = activeItems.filter((item) => selection.selectedSet.has(item.id));
    await Promise.all(selected.map((item) => cancelItem(item)));
    selection.exitSelectionMode();
    setMessage(`${selected.length} upload${selected.length === 1 ? "" : "s"} cancelled.`);
  }

  async function retrySelectedItems() {
    const selected = activeItems.filter((item) => selection.selectedSet.has(item.id));
    for (const item of selected) {
      await retryItem(item);
    }
    selection.exitSelectionMode();
    setMessage(`${selected.length} upload${selected.length === 1 ? "" : "s"} queued for retry.`);
  }

  async function removeSelectedItems() {
    const selected = activeItems.filter((item) => selection.selectedSet.has(item.id));
    await Promise.all(selected.map((item) => removeItem(item)));
    selection.exitSelectionMode();
    setMessage(`${selected.length} item${selected.length === 1 ? "" : "s"} removed from the queue.`);
  }

  async function retryItem(item: QueueItem) {
    if (item.file) {
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id ? { ...currentItem, uploadStatus: "queued", conversionStatus: "none", stage: "Queued", error: undefined, uploadProgress: 0 } : currentItem,
        ),
      );
      uploadItem(item, item.file);
      return;
    }

    const retryTarget = target ?? item.targetFormat ?? null;
    if (item.documentId && retryTarget) {
      await startProcessing([item.documentId], retryTarget);
      return;
    }

    setMessage("Choose the original file again to retry this upload.");
  }

  async function startProcessing(
    documentIds = readyToConvertItems.map((item) => item.documentId).filter(Boolean) as string[],
    selectedTarget = target,
  ) {
    if (!selectedTarget) {
      setMessage("Choose a conversion format first.");
      return;
    }

    const targetConfig = conversionTargets.find((conversionTarget) => conversionTarget.id === selectedTarget);
    if (targetConfig?.disabled) {
      setMessage(targetConfig.disabledReason ?? "This conversion is not configured yet.");
      return;
    }

    if (!documentIds.length) {
      setMessage("Upload at least one ready file before converting.");
      return;
    }

    setIsProcessing(true);
    setMessage("Conversion jobs queued");
    setItems((current) =>
      current.map((item) =>
        item.documentId && documentIds.includes(item.documentId)
          ? { ...item, conversionStatus: "queued", outputReady: false, downloadUrl: undefined, stage: "Queued", conversionProgress: 0, error: undefined }
          : item,
      ),
    );

    const response = await fetch("/api/uploads/workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds, target: selectedTarget }),
    }).catch(() => null);

    if (!response?.ok) {
      const data = (await response?.json().catch(() => null)) as { error?: string } | null;
      setMessage(data?.error ?? "Unable to start conversion.");
      setIsProcessing(false);
      return;
    }

    for (let i = 0; i < 8; i += 1) {
      await fetch("/api/jobs/process", { method: "POST" }).catch(() => null);
      await refreshWorkflow();
    }
  }

  async function saveToLibrary(item: QueueItem) {
    if (!item.documentId) return;
    const response = await fetch(`/api/documents/${item.documentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["Saved to Library"] }),
    }).catch(() => null);
    setMessage(response?.ok ? `${item.name} is saved in Documents` : "Could not update library metadata.");
  }

  async function downloadAll() {
    const conversionIds = completedConversions.map((item) => item.conversionId).filter(Boolean);
    const response = await fetch("/api/uploads/download-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversionIds }),
    }).catch(() => null);

    if (!response?.ok) {
      const data = (await response?.json().catch(() => null)) as { error?: string } | null;
      setMessage(data?.error ?? "No completed files are ready to download.");
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "docucorex-converted-results.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadItem(item: QueueItem) {
    if (!item.downloadUrl || !item.outputReady) {
      setMessage("The converted file is not ready to download yet.");
      return;
    }

    const response = await fetch(item.downloadUrl).catch(() => null);
    if (!response?.ok) {
      const data = (await response?.json().catch(() => null)) as { error?: string } | null;
      setMessage(data?.error ?? "The converted file is not ready to download yet.");
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.downloadUrl.split("/").pop() ?? `${item.name}-converted`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
  }

  return (
    <div className="space-y-6">
      <section
        className={`rounded-[2rem] border-2 border-dashed p-6 shadow-sm sm:p-10 ${dragActive ? "border-royal-600 bg-royal-50" : "border-royal-200 bg-white"}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-royal-50 text-royal-600">
            <UploadCloud className="h-8 w-8" />
          </div>
          <h2 className="mt-5 text-2xl font-semibold text-navy-950">Drag and drop files here</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Upload PDFs, Office files, text files, images and ZIP archives up to 200 MB per file. Originals are saved to Documents automatically.
          </p>
          {workflow ? <p className="mt-2 text-sm font-semibold text-royal-700">Selected workflow: {workflow.replace(/_/g, " ")}</p> : null}
          <input
            ref={fileInputRef}
            accept={supportedExtensions.join(",")}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={folderInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full bg-royal-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-royal-700"
            >
              Choose Files
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 shadow-sm hover:text-royal-700"
            >
              <FolderUp className="h-4 w-4" />
              Choose Folder
            </button>
          </div>
        </div>
      </section>

      {latestReadyItem ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-semibold text-navy-950">What would you like to do?</h2>
          <p className="mt-1 text-sm text-slate-500">{latestReadyItem.name}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setTarget("pdf")}
              className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-left text-sm font-semibold text-navy-950"
            >
              Convert Document
            </button>
            <Link href={`/upload?workflow=scan_document`} className="inline-flex min-h-11 items-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-navy-950">
              OCR & Text Extraction
            </Link>
            <Link
              href="/accounting"
              className={`inline-flex min-h-11 items-center rounded-2xl border px-4 text-sm font-semibold ${shouldRecommendAccounting ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-navy-950"}`}
            >
              {shouldRecommendAccounting ? "Recommended: Accounting Intelligence" : "Accounting Intelligence"}
            </Link>
            <Link href={`/documents/${latestReadyItem.documentId}`} className="inline-flex min-h-11 items-center rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-navy-950">
              Open Original
            </Link>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-navy-950">After upload, convert to</h2>
            <p className="mt-1 text-sm text-slate-500">Choose one conversion target for the uploaded queue.</p>
          </div>
          <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600">{message}</div>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-5">
          {conversionTargets.map((conversionTarget) => {
            const Icon = conversionTarget.icon;
            const selected = target === conversionTarget.id;
            const canConvert = !conversionTarget.disabled && readyToConvertItems.length > 0 && !isProcessing;
            return (
              <article
                key={conversionTarget.id}
                title={conversionTarget.disabled ? conversionTarget.disabledReason : conversionTarget.description}
                className={`flex min-h-48 flex-col rounded-xl border p-5 text-center transition ${
                  selected ? "border-royal-500 bg-royal-50 shadow-sm" : "border-slate-200 bg-white shadow-sm hover:border-royal-200"
                } ${conversionTarget.disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <button
                  type="button"
                  disabled={conversionTarget.disabled}
                  onClick={() => setTarget(conversionTarget.id)}
                  className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-royal-600 disabled:cursor-not-allowed"
                  aria-label={`Select ${conversionTarget.title} conversion`}
                >
                  <Icon className="h-7 w-7" />
                </button>
                <p className="mt-5 text-lg font-semibold text-navy-950">{conversionTarget.title}</p>
                <p className="mt-2 flex-1 text-sm leading-6 text-slate-500">{conversionTarget.description}</p>
                {conversionTarget.disabled ? <p className="mt-3 text-xs font-semibold text-amber-700">{conversionTarget.disabledReason}</p> : null}
                <button
                  type="button"
                  disabled={!canConvert}
                  onClick={() => {
                    setTarget(conversionTarget.id);
                    void startProcessing(undefined, conversionTarget.id);
                  }}
                  className={`mt-5 rounded-2xl px-4 py-2.5 text-sm font-semibold transition ${
                    selected
                      ? "bg-royal-600 text-white shadow-sm hover:bg-royal-700"
                      : "bg-slate-100 text-royal-700 hover:bg-royal-50"
                  } disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
                  title={
                    conversionTarget.disabled
                      ? conversionTarget.disabledReason
                      : !readyToConvertItems.length
                        ? "Upload files before converting"
                        : "Convert uploaded files"
                  }
                >
                  Convert
                </button>
              </article>
            );
          })}
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-bold text-slate-500">{activeItems.length} files in active queue • {totalProgress}% overall</div>
          <div className="text-sm font-semibold text-slate-500">
            {readyToConvertItems.length ? `${readyToConvertItems.length} ready to convert` : "Upload files to enable conversion"}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-navy-950">Upload Queue</h2>
            <p className="mt-1 text-sm text-slate-500">Active upload and conversion jobs for this workflow only.</p>
          </div>
          <div className="flex gap-2">
            {activeItems.length ? (
              <button
                type="button"
                onClick={() => (selection.isSelectionMode ? selection.exitSelectionMode() : selection.enterSelectionMode())}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 hover:text-royal-700"
              >
                {selection.isSelectionMode ? "Cancel Selection" : "Select"}
              </button>
            ) : null}
            <button type="button" onClick={() => void refreshWorkflow()} className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600 hover:text-royal-700">
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void downloadAll()}
              disabled={completedConversions.length < 2}
              className="rounded-full bg-royal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-45"
              title={completedConversions.length < 2 ? "Process multiple files before downloading all" : "Download all completed conversions as ZIP"}
            >
              Download All
            </button>
          </div>
        </div>

        {!activeItems.length ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
            <Archive className="mx-auto h-10 w-10 text-slate-400" />
            <p className="mt-3 font-semibold text-navy-950">No active files in the queue</p>
            <p className="mt-1 text-sm text-slate-500">Upload files to start a processing workflow.</p>
          </div>
        ) : null}

        {selection.isSelectionMode && selection.hasSelection ? (
          <BulkActionToolbar count={selection.selectedCount} entity="upload" onClear={selection.exitSelectionMode}>
            <button type="button" onClick={() => void retrySelectedItems()} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
              <RefreshCcw className="h-4 w-4" />
              Retry
            </button>
            <button type="button" onClick={() => void cancelSelectedItems()} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
              <X className="h-4 w-4" />
              Cancel
            </button>
            <button type="button" onClick={() => void removeSelectedItems()} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-rose-600 px-3 text-xs font-black text-white">
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </BulkActionToolbar>
        ) : null}

        <div className="space-y-3">
          {selection.isSelectionMode && activeItems.length ? (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <SelectionCheckbox
                checked={selection.allVisibleSelected}
                indeterminate={selection.someVisibleSelected && !selection.allVisibleSelected}
                label="Select all uploads"
                onChange={selection.toggleAllVisible}
              />
              <span className="text-xs font-semibold text-slate-500">Select all active queue items</span>
            </div>
          ) : null}
          {activeItems.map((item) => (
            <article
              key={item.id}
              className={`rounded-2xl border bg-slate-50 p-4 ${selection.selectedSet.has(item.id) ? "border-royal-300 ring-2 ring-royal-100" : "border-slate-200"}`}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return;
                const timer = window.setTimeout(() => selection.toggleOne(item.id), 450);
                const clear = () => window.clearTimeout(timer);
                event.currentTarget.addEventListener("pointerup", clear, { once: true });
                event.currentTarget.addEventListener("pointerleave", clear, { once: true });
              }}
            >
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex min-w-0 items-start gap-4">
                  {selection.isSelectionMode ? <div onClick={(event) => event.stopPropagation()}>
                    <SelectionCheckbox
                      checked={selection.selectedSet.has(item.id)}
                      label={`Select ${item.name}`}
                      onChange={(event) => selection.toggleOne(item.id, { shiftKey: checkboxShiftKey(event) })}
                    />
                  </div> : null}
                  <div className="rounded-2xl bg-white p-3 text-royal-600 shadow-sm">
                    <File className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-navy-950">{item.name}</p>
                    <p className="mt-1 text-sm text-slate-500">
                      {formatBytes(item.size)} • {item.mimeType || "application/octet-stream"}
                    </p>
                    {item.error ? <p className="mt-1 text-sm font-bold text-rose-600">{item.error}</p> : null}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:min-w-[420px] xl:grid-cols-2">
                  <div className={`rounded-full border px-3 py-2 text-center text-xs font-semibold ${statusTone(item.uploadStatus === "uploaded" ? item.conversionStatus === "none" ? "ready" : item.conversionStatus : item.uploadStatus)}`}>
                    {primaryStatus(item)}
                  </div>
                  <div className="rounded-full bg-white px-3 py-2 text-center text-xs font-semibold text-slate-600">{secondaryStatus(item)}</div>
                  {item.uploadStatus === "uploading" ? (
                    <>
                      <div className="rounded-full bg-white px-3 py-2 text-center text-xs font-semibold text-slate-600">{formatBytes(item.speedBps)}/s</div>
                      <div className="rounded-full bg-white px-3 py-2 text-center text-xs font-semibold text-slate-600">ETA {formatTime(item.etaSeconds)}</div>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
                <div>
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                    <span>{item.uploadStatus === "uploading" ? `Elapsed ${formatTime(item.elapsedSeconds)}` : item.stage}</span>
                    <span>{visibleProgress(item)}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                    <div className="h-full rounded-full bg-royal-600 transition-all" style={{ width: `${visibleProgress(item)}%` }} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => pauseItem(item)}
                    disabled={item.uploadStatus !== "uploading"}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-royal-700 disabled:cursor-not-allowed disabled:opacity-35"
                    title="Pause upload"
                    aria-label={`Pause ${item.name}`}
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => resumeItem(item)}
                    disabled={item.uploadStatus !== "paused"}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-royal-700 disabled:cursor-not-allowed disabled:opacity-35"
                    title="Resume upload from the beginning"
                    aria-label={`Resume ${item.name}`}
                  >
                    <Play className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void retryItem(item)}
                    disabled={item.uploadStatus !== "failed" && item.conversionStatus !== "failed"}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-royal-700 disabled:cursor-not-allowed disabled:opacity-35"
                    title="Retry"
                    aria-label={`Retry ${item.name}`}
                  >
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancelItem(item)}
                    disabled={item.conversionStatus === "completed"}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-35"
                    title="Cancel"
                    aria-label={`Cancel ${item.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeItem(item)}
                    className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-rose-600"
                    title="Remove from queue"
                    aria-label={`Remove ${item.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  {item.downloadUrl && item.outputReady ? (
                    <button type="button" onClick={() => void downloadItem(item)} className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:text-royal-700">
                      <Download className="h-4 w-4" /> Download
                    </button>
                  ) : null}
                  {item.documentId ? (
                    <Link href={`/documents/${item.documentId}?tab=preview`} className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:text-royal-700">
                      <Eye className="h-4 w-4" /> Preview
                    </Link>
                  ) : null}
                  {item.documentId ? (
                    <Link href={`/documents/${item.documentId}`} className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:text-royal-700">
                      <FileText className="h-4 w-4" /> Open Document
                    </Link>
                  ) : null}
                  {item.documentId ? (
                    <button type="button" onClick={() => void saveToLibrary(item)} className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm hover:text-royal-700">
                      <Save className="h-4 w-4" /> Save to Library
                    </button>
                  ) : null}
                  {item.conversionStatus === "completed" ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : item.uploadStatus === "failed" || item.conversionStatus === "failed" ? <XCircle className="h-5 w-5 text-rose-500" /> : <Clock3 className="h-5 w-5 text-royal-500" />}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <MobileBulkBar count={selection.isSelectionMode ? selection.selectedCount : 0} onClear={selection.exitSelectionMode}>
        <button type="button" onClick={() => void removeSelectedItems()} className="min-h-10 rounded-lg bg-rose-600 px-2 text-xs font-black text-white">Delete</button>
        <button type="button" onClick={() => void retrySelectedItems()} className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-black text-slate-700">Retry</button>
        <button type="button" onClick={() => void cancelSelectedItems()} className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-black text-slate-700">Cancel</button>
      </MobileBulkBar>
    </div>
  );
}

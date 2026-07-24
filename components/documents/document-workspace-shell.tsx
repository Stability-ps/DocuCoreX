"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Download,
  RefreshCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { DocumentRecord, DocumentStatus } from "@/lib/types";
import { DocumentUploadPanel } from "@/components/documents/document-upload-panel";
import { DocumentList } from "@/components/documents/document-list";
import type { DocumentActionHandlers } from "@/components/documents/document-actions";
import { createDocumentConversion, waitForDownloadReady, wakeConversionWorker } from "@/components/documents/conversion-client";
import { useEscapeToClose } from "@/lib/use-escape-to-close";

type ScopeFilter = "all" | "processing" | "review" | "completed" | "shared" | "archived" | "trash";

const FILTER_CHIPS: Array<{ id: ScopeFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "processing", label: "Processing" },
  { id: "review", label: "Review Required" },
  { id: "completed", label: "Completed" },
  { id: "shared", label: "Shared" },
  { id: "archived", label: "Archived" },
  { id: "trash", label: "Trash" },
];

const CONVERT_TARGETS: Array<{ id: "pdf" | "word" | "excel" | "zip"; label: string; hint: string }> = [
  { id: "pdf", label: "PDF", hint: "Generate a PDF from this file" },
  { id: "word", label: "Word", hint: "Extract text into an editable DOCX" },
  { id: "excel", label: "Excel", hint: "Extract tables into XLSX worksheets" },
  { id: "zip", label: "ZIP", hint: "Bundle processed results into a ZIP" },
];

function matchesScope(document: DocumentRecord, scope: ScopeFilter): boolean {
  const inTrash = Boolean(document.deletedAt);
  switch (scope) {
    case "trash":
      return inTrash;
    case "archived":
      return !inTrash && document.status === "archived";
    case "shared":
      return !inTrash && Boolean(document.shared);
    case "processing":
      return !inTrash && ["uploaded", "queued", "processing"].includes(document.status);
    case "review":
      return !inTrash && document.status === "review";
    case "completed":
      return !inTrash && document.status === "ready";
    case "all":
    default:
      return !inTrash && document.status !== "archived";
  }
}

export function DocumentWorkspaceShell({ initialFilter = "all" }: { initialFilter?: ScopeFilter }) {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>(initialFilter);
  const [message, setMessage] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [convertTarget, setConvertTarget] = useState<DocumentRecord | null>(null);
  useEscapeToClose(Boolean(convertTarget), () => setConvertTarget(null));
  const sessionRedirectedRef = useRef(false);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      if (response.status === 401) {
        if (!sessionRedirectedRef.current) {
          sessionRedirectedRef.current = true;
          window.setTimeout(() => {
            window.location.href = "/login?reason=session-expired";
          }, 300);
        }
        return;
      }
      if (!response.ok) {
        setLoadState("error");
        return;
      }
      const data = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents ?? []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Poll while anything is actively processing so statuses update live.
  const hasActive = useMemo(
    () => documents.some((document) => ["queued", "processing"].includes(document.status)),
    [documents],
  );
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void fetch("/api/jobs/process", { method: "POST" }).catch(() => null);
      void loadDocuments();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActive, loadDocuments]);

  const visibleDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents
      .filter((document) => matchesScope(document, scope))
      .filter((document) => {
        if (!normalizedQuery) return true;
        const haystack = [document.name, document.detectedType, document.status, ...document.tags]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [documents, scope, query]);

  const visibleIds = useMemo(() => visibleDocuments.map((document) => document.id), [visibleDocuments]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Drop selections that scrolled out of the current view.
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => visibleIds.includes(id)));
  }, [visibleIds]);

  function setBusy(id: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelectionMode(true);
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selectedId) => selectedId !== id) : [...current, id],
    );
  }

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds([]);
  }

  function patchLocal(id: string, patch: Partial<DocumentRecord>) {
    setDocuments((current) => current.map((document) => (document.id === id ? { ...document, ...patch } : document)));
  }

  // ── Action handlers ──────────────────────────────────────────────────────

  const handlers: DocumentActionHandlers = {
    onOpen: (document) => router.push(`/documents/${document.id}`),
    onReview: (document) => router.push(`/documents/${document.id}`),
    onProcess: async (document) => {
      setBusy(document.id, true);
      setMessage(`Processing ${document.name}…`);
      patchLocal(document.id, { status: "processing" });
      try {
        await fetch(`/api/ocr/${document.id}`, { method: "POST" }).catch(() => null);
        await fetch(`/api/extractions/${document.id}`, { method: "POST" }).catch(() => null);
        await loadDocuments();
        setMessage(`${document.name} processed. Review the extracted data.`);
      } finally {
        setBusy(document.id, false);
      }
    },
    onConvert: (document) => setConvertTarget(document),
    onRename: async (document) => {
      const nextName = window.prompt("Rename document", document.name)?.trim();
      if (!nextName || nextName === document.name) return;
      patchLocal(document.id, { name: nextName });
      try {
        const response = await fetch(`/api/documents/${document.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nextName }),
        });
        if (!response.ok) throw new Error();
        setMessage(`Renamed to “${nextName}”.`);
      } catch {
        patchLocal(document.id, { name: document.name });
        setMessage("Unable to rename document.");
      }
    },
    onStar: async (document) => {
      const nextStarred = !document.starred;
      patchLocal(document.id, { starred: nextStarred });
      try {
        const response = await fetch(`/api/documents/${document.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ starred: nextStarred }),
        });
        if (!response.ok) throw new Error();
        setMessage(nextStarred ? `Starred ${document.name}.` : `Removed star from ${document.name}.`);
      } catch {
        patchLocal(document.id, { starred: document.starred });
        setMessage("Unable to update star.");
      }
    },
    onDownload: (document) => {
      window.open(`/api/documents/${document.id}/download`, "_blank", "noopener,noreferrer");
    },
    onExport: async (document) => {
      setBusy(document.id, true);
      try {
        const response = await fetch(`/api/downloads/${document.id}`).catch(() => null);
        const data = (await response?.json().catch(() => null)) as
          | { downloads?: Array<{ status: string; href: string }> }
          | null;
        const ready = data?.downloads?.find((download) => download.status === "ready" && download.href);
        if (ready) {
          window.open(ready.href, "_blank", "noopener,noreferrer");
          setMessage(`Exported ${document.name}.`);
        } else {
          window.open(`/api/documents/${document.id}/download`, "_blank", "noopener,noreferrer");
          setMessage("No converted export yet — downloaded the original file.");
        }
      } finally {
        setBusy(document.id, false);
      }
    },
    onDelete: async (document) => {
      setBusy(document.id, true);
      const previous = documents;
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      try {
        const response = await fetch(`/api/documents/${document.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deletedAt: new Date().toISOString() }),
        });
        if (!response.ok) throw new Error();
        setMessage(`${document.name} moved to Trash.`);
      } catch {
        setDocuments(previous);
        setMessage("Unable to delete document.");
      } finally {
        setBusy(document.id, false);
      }
    },
  };

  async function runConversion(target: "pdf" | "word" | "excel" | "zip") {
    if (!convertTarget) return;
    const document = convertTarget;
    setConvertTarget(null);
    setBusy(document.id, true);
    setMessage(`Converting ${document.name} to ${target.toUpperCase()}…`);
    patchLocal(document.id, { status: "processing" });
    try {
      const conversion = await createDocumentConversion(document.id, target);
      await wakeConversionWorker(conversion);
      await waitForDownloadReady(conversion, {
        onStatus: (nextMessage) => setMessage(`${document.name}: ${nextMessage}`),
      });
      await loadDocuments();
      setMessage(`${document.name} converted. Download is ready in History.`);
    } catch (error) {
      await loadDocuments();
      setMessage(error instanceof Error ? error.message : "Conversion failed.");
    } finally {
      setBusy(document.id, false);
    }
  }

  // ── Bulk actions ─────────────────────────────────────────────────────────

  async function bulkAction(action: "delete" | "archive" | "restore") {
    if (!selectedIds.length) return;
    const ids = [...selectedIds];
    const previous = documents;
    if (action === "delete") {
      setDocuments((current) => current.filter((document) => !ids.includes(document.id)));
    } else if (action === "archive") {
      setDocuments((current) =>
        current.map((document) => (ids.includes(document.id) ? { ...document, status: "archived" } : document)),
      );
    }
    exitSelection();
    try {
      const response = await fetch("/api/documents/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids, action }),
      });
      if (!response.ok) throw new Error();
      await loadDocuments();
      setMessage(
        `${ids.length} document${ids.length === 1 ? "" : "s"} ${
          action === "delete" ? "moved to Trash" : action === "archive" ? "archived" : "restored"
        }.`,
      );
    } catch {
      setDocuments(previous);
      setMessage("Bulk action failed.");
    }
  }

  async function bulkPermanentDelete() {
    if (!selectedIds.length) return;
    const ids = [...selectedIds];
    const previous = documents;
    setDocuments((current) => current.filter((document) => !ids.includes(document.id)));
    exitSelection();
    try {
      const response = await fetch("/api/documents/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids }),
      });
      if (!response.ok) throw new Error();
      setMessage(`${ids.length} document${ids.length === 1 ? "" : "s"} permanently deleted.`);
    } catch {
      setDocuments(previous);
      setMessage("Unable to permanently delete.");
    }
  }

  function bulkDownload() {
    const selected = visibleDocuments.filter((document) => selectedSet.has(document.id));
    selected.slice(0, 10).forEach((document) =>
      window.open(`/api/documents/${document.id}/download`, "_blank", "noopener,noreferrer"),
    );
    setMessage(`${Math.min(selected.length, 10)} download${selected.length === 1 ? "" : "s"} started.`);
    exitSelection();
  }

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<DocumentStatus, number>> = {};
    for (const document of documents) {
      if (document.deletedAt) continue;
      counts[document.status] = (counts[document.status] ?? 0) + 1;
    }
    return counts;
  }, [documents]);

  return (
    <div className="space-y-4 p-4 pb-32 sm:p-6 lg:space-y-5 lg:p-8 lg:pb-8">
      <DocumentUploadPanel onUploaded={loadDocuments} />

      {/* Toolbar */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents…"
              className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 text-sm font-semibold text-navy-950 outline-none transition focus:border-royal-300 focus:ring-4 focus:ring-royal-100"
            />
          </label>
          <div className="flex items-center gap-2">
            {selectionMode ? (
              <button
                type="button"
                onClick={exitSelection}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSelectionMode(true)}
                disabled={!visibleDocuments.length}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 disabled:opacity-40"
              >
                Select
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadDocuments()}
              aria-label="Refresh"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600"
            >
              <RefreshCcw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {FILTER_CHIPS.map((chip) => {
            const active = scope === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setScope(chip.id)}
                className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${
                  active
                    ? "border-royal-300 bg-royal-600 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-royal-200"
                }`}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>

      {message ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
          <p className="text-sm font-semibold text-slate-600">{message}</p>
          <button type="button" onClick={() => setMessage("")} aria-label="Dismiss" className="text-slate-400">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Desktop bulk toolbar */}
      {selectionMode && selectedIds.length ? (
        <div className="sticky top-2 z-20 hidden flex-wrap items-center justify-between gap-3 rounded-xl border border-royal-200 bg-royal-50 px-4 py-3 shadow-sm lg:flex">
          <p className="text-sm font-black text-navy-950">
            {selectedIds.length} selected
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <BulkButton icon={Download} label="Download" onClick={bulkDownload} />
            {scope === "trash" ? (
              <>
                <BulkButton icon={ArchiveRestore} label="Restore" onClick={() => void bulkAction("restore")} />
                <BulkButton icon={Trash2} label="Delete permanently" tone="danger" onClick={() => void bulkPermanentDelete()} />
              </>
            ) : (
              <>
                <BulkButton icon={Archive} label="Archive" onClick={() => void bulkAction("archive")} />
                <BulkButton icon={Trash2} label="Delete" tone="danger" onClick={() => void bulkAction("delete")} />
              </>
            )}
          </div>
        </div>
      ) : null}

      {loadState === "loading" ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-16 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : loadState === "error" ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-700">Unable to load documents.</p>
        </div>
      ) : (
        <DocumentList
          documents={visibleDocuments}
          selectionMode={selectionMode}
          selectedSet={selectedSet}
          busyIds={busyIds}
          handlers={handlers}
          onToggleSelect={toggleSelect}
          emptyLabel={query ? "No matching documents" : scope === "trash" ? "Trash is empty" : "No documents yet"}
          emptyDescription={
            query
              ? "Try a different search term or filter."
              : scope === "all"
                ? "Upload a file above to get started."
                : "Nothing here yet."
          }
        />
      )}

      {/* Mobile bulk bar */}
      {selectionMode && selectedIds.length ? (
        <div className="fixed inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-50 rounded-2xl border border-royal-200 bg-white p-3 shadow-xl lg:hidden">
          <div className="flex items-center justify-between">
            <p className="text-sm font-black text-navy-950">Selected: {selectedIds.length}</p>
            <button type="button" onClick={exitSelection} className="text-xs font-black text-slate-500">
              Exit
            </button>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <MobileBulkButton icon={Download} label="Download" onClick={bulkDownload} />
            {scope === "trash" ? (
              <>
                <MobileBulkButton icon={ArchiveRestore} label="Restore" onClick={() => void bulkAction("restore")} />
                <MobileBulkButton icon={Trash2} label="Delete" tone="danger" onClick={() => void bulkPermanentDelete()} />
              </>
            ) : (
              <>
                <MobileBulkButton icon={Archive} label="Archive" onClick={() => void bulkAction("archive")} />
                <MobileBulkButton icon={Trash2} label="Delete" tone="danger" onClick={() => void bulkAction("delete")} />
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* Convert format modal */}
      {convertTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 p-4 sm:items-center" onClick={() => setConvertTarget(null)} role="dialog" aria-modal="true" aria-label="Convert document">
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-navy-950">Convert document</h2>
                <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{convertTarget.name}</p>
              </div>
              <button type="button" onClick={() => setConvertTarget(null)} aria-label="Close" className="text-slate-400">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {CONVERT_TARGETS.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => void runConversion(target.id)}
                  className="rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-royal-300 hover:bg-royal-50"
                >
                  <p className="text-sm font-bold text-navy-950">{target.label}</p>
                  <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{target.hint}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {loadState === "ready" && !selectionMode ? (
        <p className="text-xs font-semibold text-slate-400">
          {visibleDocuments.length} shown · {statusCounts.processing ?? 0} processing · {statusCounts.review ?? 0} need review · {statusCounts.ready ?? 0} completed
        </p>
      ) : null}
    </div>
  );
}

function BulkButton({
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: typeof Download;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-black transition ${
        tone === "danger"
          ? "border-rose-200 bg-white text-rose-600 hover:bg-rose-50"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function MobileBulkButton({
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: typeof Download;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border text-[11px] font-black transition ${
        tone === "danger" ? "border-rose-200 bg-white text-rose-600" : "border-slate-200 bg-white text-slate-700"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

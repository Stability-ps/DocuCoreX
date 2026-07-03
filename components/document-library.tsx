"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Download, Filter, MoreVertical, Search, Share2, Star, Trash2 } from "lucide-react";
import { BulkActionToolbar, MobileBulkBar, SelectionCheckbox, armMobileLongPressSelection, checkboxShiftKey, useBulkSelection } from "@/components/bulk-selection";
import { StatusPill } from "@/components/ui";
import type { DocumentRecord } from "@/lib/types";

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function titleCase(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const FILTER_CHIPS = ["All Documents", "Recent", "Processing", "Converted"] as const;
type FilterChip = (typeof FILTER_CHIPS)[number];
const DOCUMENTS_CACHE_KEY = "docucorex:documents:list";
const DOCUMENTS_CACHE_TTL_MS = 60_000;

export function DocumentLibrary({ initialFilter = "Recent" }: { initialFilter?: string }) {
  const router = useRouter();

  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterChip>(
    FILTER_CHIPS.includes(initialFilter as FilterChip) ? (initialFilter as FilterChip) : "Recent",
  );
  const [status, setStatus] = useState("Loading library…");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [visibleCount, setVisibleCount] = useState(24);
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const [shareDocumentId, setShareDocumentId] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState("");
  const [renameDocumentId, setRenameDocumentId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDocumentId, setDeleteDocumentId] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [moreMenuDocumentId, setMoreMenuDocumentId] = useState<string | null>(null);

  const sessionRedirectedRef = useRef(false);

  const shareDocument = useMemo(() => documents.find((document) => document.id === shareDocumentId) ?? null, [documents, shareDocumentId]);
  const renameDocument = useMemo(() => documents.find((document) => document.id === renameDocumentId) ?? null, [documents, renameDocumentId]);
  const deleteDocument = useMemo(() => documents.find((document) => document.id === deleteDocumentId) ?? null, [documents, deleteDocumentId]);

  useEffect(() => {
    const cachedDocuments = readCached<DocumentRecord[]>(DOCUMENTS_CACHE_KEY, DOCUMENTS_CACHE_TTL_MS);
    if (cachedDocuments?.length) {
      setDocuments(cachedDocuments);
      setStatus(`${cachedDocuments.length} documents loaded`);
    }

    const controller = new AbortController();

    async function loadDocuments() {
      try {
        const response = await fetch("/api/documents", { signal: controller.signal });

        if (response.status === 401) {
          setActionError("Session expired. Redirecting to login…");
          if (!sessionRedirectedRef.current) {
            sessionRedirectedRef.current = true;
            window.setTimeout(() => {
              window.location.href = "/login?reason=session-expired";
            }, 300);
          }
          return;
        }

        if (!response.ok) {
          setStatus("Unable to load documents");
          return;
        }

        const data = (await response.json()) as { documents: DocumentRecord[] };
        setDocuments(data.documents);
        setStatus(`${data.documents.length} documents loaded`);
        writeCached(DOCUMENTS_CACHE_KEY, data.documents);
      } catch {
        setStatus("Unable to load documents");
      }
    }

    void loadDocuments();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    setVisibleCount(24);
  }, [activeFilter, query]);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = documents.filter((document) => {
      const updatedAt = new Date(document.updatedAt);
      const searchable = [
        document.name,
        document.detectedType,
        document.status,
        updatedAt.toLocaleDateString(),
        updatedAt.toISOString().slice(0, 10),
        ...document.tags,
      ]
        .join(" ")
        .toLowerCase();

      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      const matchesFilter =
        activeFilter === "All Documents"
          ? !document.deletedAt
          : activeFilter === "Recent"
            ? !document.deletedAt
            : activeFilter === "Processing"
              ? !document.deletedAt && ["uploaded", "queued", "processing"].includes(document.status)
              : !document.deletedAt && ((document.tags ?? []).some((tag) => tag.toLowerCase() === "converted") || document.status === "ready");

      return matchesQuery && matchesFilter;
    });

    if (activeFilter === "Recent") {
      return [...filtered].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    }

    return filtered;
  }, [activeFilter, documents, query]);

  const visibleDocuments = useMemo(() => filteredDocuments.slice(0, visibleCount), [filteredDocuments, visibleCount]);
  const selection = useBulkSelection(visibleDocuments);

  useEffect(() => {
    for (const document of visibleDocuments.slice(0, 12)) {
      router.prefetch(`/documents/${document.id}`);
      router.prefetch(`/convert?documentId=${document.id}`);
    }
  }, [router, visibleDocuments]);

  function setBusy(key: string, busy: boolean) {
    setBusyKeys((current) => ({ ...current, [key]: busy }));
  }

  function isBusy(key: string) {
    return Boolean(busyKeys[key]);
  }

  async function fetchWithSessionHandling(input: RequestInfo | URL, init?: RequestInit) {
    const response = await fetch(input, init);

    if (response.status === 401) {
      setActionError("Session expired. Redirecting to login…");
      if (!sessionRedirectedRef.current) {
        sessionRedirectedRef.current = true;
        window.setTimeout(() => {
          window.location.href = "/login?reason=session-expired";
        }, 300);
      }
    }

    return response;
  }

  async function patchDocument(id: string, patch: Partial<DocumentRecord>) {
    const response = await fetchWithSessionHandling(`/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      throw new Error("Failed to update document");
    }

    const data = (await response.json()) as { document: DocumentRecord };
    setDocuments((current) => current.map((document) => (document.id === id ? data.document : document)));
    return data.document;
  }

  function openDocument(documentId: string) {
    router.push(`/documents/${documentId}`);
  }

  async function handleToggleStar(document: DocumentRecord) {
    const key = `star:${document.id}`;
    if (isBusy(key)) return;

    setActionMessage("");
    setActionError("");
    setBusy(key, true);

    const nextStarred = !document.starred;
    setDocuments((current) => current.map((item) => (item.id === document.id ? { ...item, starred: nextStarred } : item)));

    try {
      await patchDocument(document.id, { starred: nextStarred });
      setActionMessage(nextStarred ? "Document starred." : "Star removed.");
    } catch {
      setDocuments((current) => current.map((item) => (item.id === document.id ? { ...item, starred: document.starred } : item)));
      setActionError("Unable to update star status.");
    } finally {
      setBusy(key, false);
    }
  }

  function openShareModal(document: DocumentRecord) {
    setShareDocumentId(document.id);
    setShareEmail("");
    setActionMessage("");
    setActionError("");
  }

  async function handleCopyShareLink() {
    if (!shareDocument) return;

    const key = `share:${shareDocument.id}`;
    if (isBusy(key)) return;

    setBusy(key, true);
    setActionMessage("");
    setActionError("");

    try {
      const link = `${window.location.origin}/documents/${shareDocument.id}`;
      await navigator.clipboard.writeText(link);
      await patchDocument(shareDocument.id, { shared: true });
      setActionMessage("Share link copied.");
    } catch {
      setActionError("Unable to copy share link.");
    } finally {
      setBusy(key, false);
    }
  }

  async function handleSendShareEmail() {
    if (!shareEmail.trim()) {
      setActionError("Enter an email address or copy the link.");
      return;
    }

    setActionError("");
    setActionMessage("Email sharing coming soon.");
  }

  async function handleDeleteToTrash() {
    if (!deleteDocument) return;

    const key = `delete:${deleteDocument.id}`;
    if (isBusy(key)) return;

    setBusy(key, true);
    setActionMessage("");
    setActionError("");

    const previousDeletedAt = deleteDocument.deletedAt ?? null;
    const nextDeletedAt = new Date().toISOString();

    setDocuments((current) => current.map((item) => (item.id === deleteDocument.id ? { ...item, deletedAt: nextDeletedAt } : item)));

    try {
      await patchDocument(deleteDocument.id, { deletedAt: nextDeletedAt });
      setActionMessage("Document moved to trash.");
      setDeleteDocumentId(null);
      setMoreMenuDocumentId(null);
    } catch {
      setDocuments((current) => current.map((item) => (item.id === deleteDocument.id ? { ...item, deletedAt: previousDeletedAt } : item)));
      setActionError("Unable to delete document.");
    } finally {
      setBusy(key, false);
    }
  }

  async function handleBulkDelete() {
    const ids = selection.selectedIds;
    if (!ids.length || isBusy("bulk:delete")) return;

    setBusy("bulk:delete", true);
    setActionMessage("");
    setActionError("");

    const previousDocuments = documents;
    setDocuments((current) => current.filter((document) => !ids.includes(document.id)));

    try {
      const response = await fetchWithSessionHandling("/api/documents/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Unable to delete selected documents.");
      }

      selection.exitSelectionMode();
      setBulkDeleteOpen(false);
      setActionMessage(`${ids.length} document${ids.length === 1 ? "" : "s"} deleted successfully.`);
    } catch (error) {
      setDocuments(previousDocuments);
      setActionError(error instanceof Error ? error.message : "Unable to delete selected documents.");
    } finally {
      setBusy("bulk:delete", false);
    }
  }

  async function handleBulkArchive() {
    const ids = selection.selectedIds;
    if (!ids.length || isBusy("bulk:archive")) return;

    setBusy("bulk:archive", true);
    setActionMessage("");
    setActionError("");
    setDocuments((current) => current.map((document) => (ids.includes(document.id) ? { ...document, status: "archived" } : document)));

    try {
      const response = await fetchWithSessionHandling("/api/documents/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids, action: "archive" }),
      });
      if (!response.ok) throw new Error("Unable to archive selected documents.");
      selection.exitSelectionMode();
      setActionMessage(`${ids.length} document${ids.length === 1 ? "" : "s"} archived.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to archive selected documents.");
    } finally {
      setBusy("bulk:archive", false);
    }
  }

  async function handleBulkShare() {
    const ids = selection.selectedIds;
    if (!ids.length || isBusy("bulk:share")) return;

    setBusy("bulk:share", true);
    setActionMessage("");
    setActionError("");
    setDocuments((current) => current.map((document) => (ids.includes(document.id) ? { ...document, shared: true } : document)));

    try {
      const response = await fetchWithSessionHandling("/api/documents/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids, action: "share" }),
      });
      if (!response.ok) throw new Error("Unable to share selected documents.");
      selection.exitSelectionMode();
      setActionMessage(`${ids.length} document${ids.length === 1 ? "" : "s"} marked shared.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to share selected documents.");
    } finally {
      setBusy("bulk:share", false);
    }
  }

  function handleBulkDownload() {
    const selected = visibleDocuments.filter((document) => selection.selectedSet.has(document.id));
    selected.slice(0, 10).forEach((document) => window.open(`/api/documents/${document.id}/download`, "_blank", "noopener,noreferrer"));
    setActionMessage(selected.length > 10 ? "Started first 10 downloads. Use Export for larger sets." : `${selected.length} download${selected.length === 1 ? "" : "s"} started.`);
  }

  function openRenameModal(document: DocumentRecord) {
    setRenameDocumentId(document.id);
    setRenameValue(document.name);
    setActionMessage("");
    setActionError("");
    setMoreMenuDocumentId(null);
  }

  async function handleRenameSubmit() {
    if (!renameDocument) return;

    const normalizedName = renameValue.trim();
    if (!normalizedName) {
      setActionError("Name is required.");
      return;
    }

    const key = `rename:${renameDocument.id}`;
    if (isBusy(key)) return;

    setBusy(key, true);
    setActionMessage("");
    setActionError("");

    const previousName = renameDocument.name;
    setDocuments((current) => current.map((item) => (item.id === renameDocument.id ? { ...item, name: normalizedName } : item)));

    try {
      await patchDocument(renameDocument.id, { name: normalizedName } as Partial<DocumentRecord>);
      setActionMessage("Document renamed.");
      setRenameDocumentId(null);
      setRenameValue("");
    } catch {
      setDocuments((current) => current.map((item) => (item.id === renameDocument.id ? { ...item, name: previousName } : item)));
      setActionError("Unable to rename document.");
    } finally {
      setBusy(key, false);
    }
  }

  async function handleDownload(document: DocumentRecord) {
    const key = `download:${document.id}`;
    if (isBusy(key)) return;

    setBusy(key, true);
    setActionMessage("");
    setActionError("");

    try {
      const response = await fetchWithSessionHandling(`/api/downloads/${document.id}`);

      if (response.ok) {
        const data = (await response.json()) as { downloads?: Array<{ href: string; status: string }> };
        const ready = data.downloads?.find((download) => download.status === "ready" && download.href);

        if (ready?.href) {
          window.open(ready.href, "_blank", "noopener,noreferrer");
          setActionMessage("Download started.");
          return;
        }
      }

      if (!document.storagePath) {
        setActionError("Download unavailable for this document.");
        return;
      }

      window.open(`/api/documents/${document.id}/download`, "_blank", "noopener,noreferrer");
      setActionMessage("Download started.");
    } catch {
      setActionError("Unable to start download.");
    } finally {
      setBusy(key, false);
    }
  }

  function renderActionButtons(document: DocumentRecord) {
    const starBusy = isBusy(`star:${document.id}`);
    const shareBusy = isBusy(`share:${document.id}`);
    const deleteBusy = isBusy(`delete:${document.id}`);
    const downloadBusy = isBusy(`download:${document.id}`);

    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void handleToggleStar(document);
          }}
          disabled={starBusy}
          aria-label={`${document.starred ? "Unstar" : "Star"} ${document.name}`}
          className={`min-h-11 min-w-11 rounded-lg p-2 ${document.starred ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"} ${starBusy ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <Star className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openShareModal(document);
          }}
          disabled={shareBusy}
          aria-label={`Share ${document.name}`}
          className={`min-h-11 min-w-11 rounded-lg p-2 ${document.shared ? "bg-royal-100 text-royal-700" : "bg-slate-100 text-slate-600"} ${shareBusy ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <Share2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDeleteDocumentId(document.id);
          }}
          disabled={deleteBusy}
          aria-label={`Delete ${document.name}`}
          className={`min-h-11 min-w-11 rounded-lg bg-slate-100 p-2 text-slate-600 ${deleteBusy ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setMoreMenuDocumentId((current) => (current === document.id ? null : document.id));
            }}
            aria-label={`More actions for ${document.name}`}
            className="min-h-11 min-w-11 rounded-lg bg-slate-100 p-2 text-slate-600"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {moreMenuDocumentId === document.id ? (
            <div role="menu" className="absolute right-0 z-20 mt-2 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-lg" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  openDocument(document.id);
                  setMoreMenuDocumentId(null);
                }}
              >
                Open
              </button>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                onClick={() => {
                  void handleDownload(document);
                  setMoreMenuDocumentId(null);
                }}
                disabled={downloadBusy || !document.storagePath}
              >
                {document.storagePath ? "Download" : "Download unavailable"}
              </button>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => openRenameModal(document)}
              >
                Rename
              </button>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  router.push(`/convert?documentId=${document.id}`);
                  setMoreMenuDocumentId(null);
                }}
              >
                Convert
              </button>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-rose-700 hover:bg-rose-50"
                onClick={() => {
                  setDeleteDocumentId(document.id);
                  setMoreMenuDocumentId(null);
                }}
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="space-y-6"
      onClick={() => {
        setMoreMenuDocumentId(null);
      }}
    >
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex min-h-11 flex-1 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-royal-300 focus-within:bg-white">
            <Search className="h-5 w-5 text-slate-400" />
            <input
              className="w-full bg-transparent text-sm font-semibold outline-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents…"
              value={query}
            />
          </div>
          <div
            aria-live="polite"
            className="inline-flex min-h-11 cursor-default items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm"
          >
            <Filter className="h-4 w-4" />
            {status}
          </div>
          {visibleDocuments.length ? (
            <button
              type="button"
              onClick={() => (selection.isSelectionMode ? selection.exitSelectionMode() : selection.enterSelectionMode())}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:text-royal-700"
            >
              {selection.isSelectionMode ? "Cancel Selection" : "Select"}
            </button>
          ) : null}
        </div>
        {actionError ? <p className="mt-3 text-xs font-semibold text-rose-600">{actionError}</p> : null}
        {!actionError && actionMessage ? <p className="mt-3 text-xs font-semibold text-emerald-700">{actionMessage}</p> : null}
        <div className="mt-4 hidden gap-2 overflow-x-auto lg:flex">
          {FILTER_CHIPS.map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold transition ${
                activeFilter === filter ? "bg-royal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-royal-50 hover:text-royal-700"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto lg:hidden">
          {FILTER_CHIPS.map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`flex min-h-11 shrink-0 items-center rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                activeFilter === filter ? "bg-royal-600 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </section>

      {selection.isSelectionMode && selection.hasSelection ? (
        <BulkActionToolbar count={selection.selectedCount} entity="document" onClear={selection.exitSelectionMode}>
          <button type="button" onClick={handleBulkDownload} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700">
            <Download className="h-4 w-4" />
            Download
          </button>
          <button type="button" onClick={handleBulkShare} disabled={isBusy("bulk:share")} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:opacity-50">
            <Share2 className="h-4 w-4" />
            Share
          </button>
          <button type="button" onClick={handleBulkArchive} disabled={isBusy("bulk:archive")} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 disabled:opacity-50">
            <Archive className="h-4 w-4" />
            Archive
          </button>
          <button type="button" onClick={() => setBulkDeleteOpen(true)} disabled={isBusy("bulk:delete")} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-rose-600 px-3 text-xs font-black text-white disabled:opacity-50">
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </BulkActionToolbar>
      ) : null}

      <section className="space-y-2 lg:hidden">
        {visibleDocuments.map((document) => (
          <article
            key={document.id}
            className={`rounded-xl border bg-white p-3 shadow-sm ${selection.selectedSet.has(document.id) ? "border-royal-300 ring-2 ring-royal-100" : "border-slate-200"}`}
            role="button"
            tabIndex={0}
            onClick={() => (selection.isSelectionMode ? selection.toggleOne(document.id) : openDocument(document.id))}
            onPointerDown={(event) => armMobileLongPressSelection(event, () => selection.toggleOne(document.id))}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (selection.isSelectionMode) selection.toggleOne(document.id);
                else openDocument(document.id);
              }
            }}
          >
            <div className="flex items-start gap-3">
              {selection.isSelectionMode ? <div onClick={(event) => event.stopPropagation()}>
                <SelectionCheckbox
                  checked={selection.selectedSet.has(document.id)}
                  label={`Select ${document.name}`}
                  onChange={() => selection.toggleOne(document.id)}
                />
              </div> : null}
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">PDF</div>
              <div className="min-w-0 flex-1">
                <Link href={`/documents/${document.id}`} className="text-sm font-semibold text-navy-950">
                  <span
                    className="block overflow-hidden"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {document.name}
                  </span>
                </Link>
                <p className="mt-1 text-xs text-slate-500">Bank statement • {titleCase(document.detectedType)}</p>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
                  <span>{new Date(document.updatedAt).toLocaleDateString()}</span>
                  <StatusPill>{titleCase(document.status)}</StatusPill>
                </div>
              </div>
            </div>

            <div className="mt-3">{renderActionButtons(document)}</div>
          </article>
        ))}
        {visibleDocuments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center">
            <p className="text-sm font-semibold text-navy-950">No documents found</p>
            <p className="mt-1 text-xs text-slate-500">Try another search or filter.</p>
          </div>
        ) : null}
        {filteredDocuments.length > visibleCount ? (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + 24)}
            className="min-h-11 w-full rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700"
          >
            Load more
          </button>
        ) : null}
      </section>

      <section className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:block">
        <div className="grid grid-cols-[0.08fr_1.3fr_0.75fr_0.55fr_0.55fr_0.4fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 max-lg:hidden">
          <span>
            {selection.isSelectionMode ? (
            <SelectionCheckbox
              checked={selection.allVisibleSelected}
              indeterminate={selection.someVisibleSelected && !selection.allVisibleSelected}
              label="Select all visible documents"
              onChange={selection.toggleAllVisible}
            />
            ) : null}
          </span>
          <span>Name</span>
          <span>Type</span>
          <span>Status</span>
          <span>Updated</span>
          <span>Actions</span>
        </div>
        <div className="divide-y divide-slate-100">
          {visibleDocuments.map((document) => (
            <div
              key={document.id}
              className={`grid cursor-pointer gap-4 px-5 py-4 transition hover:bg-royal-50/40 lg:grid-cols-[0.08fr_1.3fr_0.75fr_0.55fr_0.55fr_0.4fr] ${selection.selectedSet.has(document.id) ? "bg-royal-50/70" : ""}`}
              onClick={() => (selection.isSelectionMode ? selection.toggleOne(document.id) : openDocument(document.id))}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (selection.isSelectionMode) selection.toggleOne(document.id);
                  else openDocument(document.id);
                }
              }}
            >
              <div onClick={(event) => event.stopPropagation()}>
                {selection.isSelectionMode ? (
                <SelectionCheckbox
                  checked={selection.selectedSet.has(document.id)}
                  label={`Select ${document.name}`}
                  onChange={(event) => selection.toggleOne(document.id, { shiftKey: checkboxShiftKey(event) })}
                />
                ) : null}
              </div>
              <div>
                <Link href={`/documents/${document.id}`} className="font-semibold text-navy-950 hover:text-royal-700">
                  {document.name}
                </Link>
                <p className="mt-1 text-sm text-slate-500">
                  {document.pageCount} pages • {formatBytes(document.sizeBytes)} • {document.mimeType}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {document.tags.map((tag) => (
                    <StatusPill key={tag}>{tag}</StatusPill>
                  ))}
                </div>
              </div>
              <p className="text-sm font-bold text-slate-600">{titleCase(document.detectedType)}</p>
              <p className="text-sm font-semibold text-royal-700">{titleCase(document.status)}</p>
              <p className="text-sm text-slate-500">{new Date(document.updatedAt).toLocaleDateString()}</p>
              <div onClick={(event) => event.stopPropagation()}>{renderActionButtons(document)}</div>
            </div>
          ))}
          {visibleDocuments.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="font-semibold text-navy-950">No documents found</p>
              <p className="mt-2 text-sm text-slate-500">Try another search or filter.</p>
            </div>
          ) : null}
        </div>
        {filteredDocuments.length > visibleCount ? (
          <div className="border-t border-slate-100 p-4">
            <button
              type="button"
              onClick={() => setVisibleCount((count) => count + 24)}
              className="min-h-11 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700"
            >
              Load more documents
            </button>
          </div>
        ) : null}
      </section>

      {shareDocument ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy-950/40 p-4" onClick={() => setShareDocumentId(null)}>
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-950">Share document</h3>
            <p className="mt-1 text-xs text-slate-500">{shareDocument.name}</p>
            <button
              type="button"
              onClick={() => void handleCopyShareLink()}
              disabled={isBusy(`share:${shareDocument.id}`)}
              className="mt-4 min-h-11 w-full rounded-lg bg-royal-600 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Copy link
            </button>
            <label className="mt-3 block">
              <span className="text-xs font-semibold text-slate-500">Share via email (optional)</span>
              <input
                value={shareEmail}
                onChange={(event) => setShareEmail(event.target.value)}
                type="email"
                placeholder="name@example.com"
                className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleSendShareEmail()}
              className="mt-3 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
            >
              Send email
            </button>
            <p className="mt-2 text-xs font-semibold text-slate-500">Email sharing coming soon.</p>
            <button
              type="button"
              onClick={() => setShareDocumentId(null)}
              className="mt-4 min-h-11 w-full rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-700"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {deleteDocument ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy-950/40 p-4" onClick={() => setDeleteDocumentId(null)}>
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-950">Delete document?</h3>
            <p className="mt-1 text-sm text-slate-500">{deleteDocument.name}</p>
            <p className="mt-2 text-xs text-slate-500">This moves the document to Trash.</p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setDeleteDocumentId(null)}
                className="min-h-11 flex-1 rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteToTrash()}
                disabled={isBusy(`delete:${deleteDocument.id}`)}
                className="min-h-11 flex-1 rounded-lg bg-rose-600 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-rose-300"
              >
                Confirm delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameDocument ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy-950/40 p-4" onClick={() => setRenameDocumentId(null)}>
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-950">Rename document</h3>
            <label className="mt-3 block">
              <span className="text-xs font-semibold text-slate-500">New name</span>
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm font-semibold text-navy-950 outline-none focus:border-royal-300"
              />
            </label>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setRenameDocumentId(null)}
                className="min-h-11 flex-1 rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRenameSubmit()}
                disabled={isBusy(`rename:${renameDocument.id}`)}
                className="min-h-11 flex-1 rounded-lg bg-royal-600 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-royal-300"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkDeleteOpen ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-navy-950/40 p-4" onClick={() => setBulkDeleteOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-950">
              Delete {selection.selectedCount} document{selection.selectedCount === 1 ? "" : "s"}?
            </h3>
            <p className="mt-2 text-sm text-slate-500">This deletes the selected document records, related jobs, versions and stored files. This action cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setBulkDeleteOpen(false)} className="min-h-11 flex-1 rounded-lg bg-slate-100 px-3 text-sm font-semibold text-slate-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBulkDelete()}
                disabled={isBusy("bulk:delete")}
                className="min-h-11 flex-1 rounded-lg bg-rose-600 px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-rose-300"
              >
                Delete {selection.selectedCount}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <MobileBulkBar count={selection.isSelectionMode ? selection.selectedCount : 0} onClear={selection.exitSelectionMode}>
        <button type="button" onClick={() => setBulkDeleteOpen(true)} className="min-h-10 rounded-lg bg-rose-600 px-2 text-xs font-black text-white">
          Delete
        </button>
        <button type="button" onClick={handleBulkDownload} className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-black text-slate-700">
          Download
        </button>
        <button type="button" onClick={handleBulkShare} className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs font-black text-slate-700">
          Share
        </button>
      </MobileBulkBar>
    </div>
  );
}

function readCached<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; at: number };
    if (Date.now() - parsed.at > ttlMs) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCached<T>(key: string, value: T) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // Ignore cache write failures.
  }
}

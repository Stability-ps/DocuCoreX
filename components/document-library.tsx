"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Filter, Search, Share2, Star, Trash2 } from "lucide-react";
import { libraryFilters } from "@/lib/product-data";
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

export function DocumentLibrary({ initialFilter = "Recent" }: { initialFilter?: string }) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState(initialFilter);
  const [status, setStatus] = useState("Loading library…");

  useEffect(() => {
    async function loadDocuments() {
      const response = await fetch("/api/documents");

      if (!response.ok) {
        setStatus("Unable to load documents");
        return;
      }

      const data = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents);
      setStatus(`${data.documents.length} documents loaded`);
    }

    void loadDocuments();
  }, []);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return documents.filter((document) => {
      const searchable = [
        document.name,
        document.detectedType,
        document.status,
        ...document.tags,
      ]
        .join(" ")
        .toLowerCase();

      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      const matchesFilter =
        activeFilter === "Recent"
          ? !document.deletedAt
          : activeFilter === "Starred"
            ? Boolean(document.starred) && !document.deletedAt
            : activeFilter === "Shared"
              ? Boolean(document.shared) && !document.deletedAt
              : activeFilter === "Trash"
                ? Boolean(document.deletedAt)
                : activeFilter === "Version History"
                  ? !document.deletedAt
                  : !document.deletedAt;

      return matchesQuery && matchesFilter;
    });
  }, [activeFilter, documents, query]);

  async function patchDocument(id: string, patch: Partial<DocumentRecord>) {
    const response = await fetch(`/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!response.ok) return;

    const data = (await response.json()) as { document: DocumentRecord };
    setDocuments((current) => current.map((document) => (document.id === id ? data.document : document)));
  }

  async function permanentlyDeleteDocument(id: string) {
    const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });

    if (!response.ok) return;

    setDocuments((current) => current.filter((document) => document.id !== id));
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex flex-1 items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 focus-within:border-royal-300 focus-within:bg-white">
            <Search className="h-5 w-5 text-slate-400" />
            <input
              className="w-full bg-transparent text-sm font-semibold outline-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search file names, tags, OCR text and extracted fields"
              value={query}
            />
          </div>
          <div
            aria-live="polite"
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-600 shadow-sm"
          >
            <Filter className="h-4 w-4" />
            {status}
          </div>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto">
          {libraryFilters.map((filter) => (
            <button
              key={filter.label}
              onClick={() => setActiveFilter(filter.label)}
              className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-black transition ${
                activeFilter === filter.label ? "bg-royal-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-royal-50 hover:text-royal-700"
              }`}
            >
              <filter.icon className="h-4 w-4" />
              {filter.label}
            </button>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-[1.3fr_0.75fr_0.55fr_0.55fr_0.4fr] gap-4 border-b border-slate-100 px-5 py-4 text-xs font-black uppercase tracking-[0.14em] text-slate-400 max-lg:hidden">
          <span>Name</span>
          <span>Type</span>
          <span>Status</span>
          <span>Updated</span>
          <span>Actions</span>
        </div>
        <div className="divide-y divide-slate-100">
          {filteredDocuments.map((document) => (
            <div key={document.id} className="grid gap-4 px-5 py-4 transition hover:bg-royal-50/40 lg:grid-cols-[1.3fr_0.75fr_0.55fr_0.55fr_0.4fr]">
              <div>
                <Link href={`/documents/${document.id}`} className="font-black text-navy-950 hover:text-royal-700">
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
              <p className="text-sm font-black text-royal-700">{titleCase(document.status)}</p>
              <p className="text-sm text-slate-500">{new Date(document.updatedAt).toLocaleDateString()}</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => patchDocument(document.id, { starred: !document.starred })}
                  aria-label={`${document.starred ? "Unstar" : "Star"} ${document.name}`}
                  className={`rounded-xl p-2 shadow-sm ${document.starred ? "bg-amber-100 text-amber-700" : "bg-white text-slate-500 hover:text-amber-600"}`}
                  title="Star"
                >
                  <Star className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => patchDocument(document.id, { shared: !document.shared })}
                  aria-label={`${document.shared ? "Unshare" : "Share"} ${document.name}`}
                  className={`rounded-xl p-2 shadow-sm ${document.shared ? "bg-royal-100 text-royal-700" : "bg-white text-slate-500 hover:text-royal-600"}`}
                  title="Share"
                >
                  <Share2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => patchDocument(document.id, { deletedAt: document.deletedAt ? null : new Date().toISOString() })}
                  aria-label={`${document.deletedAt ? "Restore" : "Move to trash"} ${document.name}`}
                  className="rounded-xl bg-white p-2 text-slate-500 shadow-sm hover:text-rose-600"
                  title={document.deletedAt ? "Restore" : "Move to trash"}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                {document.deletedAt ? (
                  <button
                    type="button"
                    onClick={() => permanentlyDeleteDocument(document.id)}
                    aria-label={`Delete ${document.name} permanently`}
                    className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 shadow-sm hover:bg-rose-100"
                    title="Delete permanently"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {filteredDocuments.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="font-black text-navy-950">No documents found</p>
              <p className="mt-2 text-sm text-slate-500">Try another search or filter.</p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

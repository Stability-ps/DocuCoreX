"use client";

import { FileText, FolderOpen } from "lucide-react";
import type { DocumentRecord } from "@/lib/types";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { DocumentRowActions, type DocumentActionHandlers } from "@/components/documents/document-actions";
import {
  DocumentCard,
  detectedTypeLabel,
  formatBytes,
  formatRelativeTime,
} from "@/components/documents/document-card";

export function DocumentList({
  documents,
  selectionMode,
  selectedSet,
  busyIds,
  handlers,
  onToggleSelect,
  emptyLabel = "No documents yet",
  emptyDescription = "Upload a file above to get started.",
}: {
  documents: DocumentRecord[];
  selectionMode: boolean;
  selectedSet: Set<string>;
  busyIds: Set<string>;
  handlers: DocumentActionHandlers;
  onToggleSelect: (id: string) => void;
  emptyLabel?: string;
  emptyDescription?: string;
}) {
  if (!documents.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
        <FolderOpen className="h-10 w-10 text-slate-300" />
        <div>
          <p className="text-base font-bold text-navy-950">{emptyLabel}</p>
          <p className="mt-1 text-sm font-semibold text-slate-500">{emptyDescription}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white lg:block">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr className="text-left text-[11px] font-black uppercase tracking-wide text-slate-500">
              {selectionMode ? <th className="w-10 px-4 py-3" aria-label="Select" /> : null}
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Size</th>
              <th className="px-4 py-3 text-right">Updated</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {documents.map((document) => {
              const selected = selectedSet.has(document.id);
              return (
                <tr key={document.id} className={selected ? "bg-royal-50/40" : "hover:bg-slate-50/60"}>
                  {selectionMode ? (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleSelect(document.id)}
                        aria-label={`Select ${document.name}`}
                        className="h-4 w-4 rounded border-slate-300 accent-royal-600"
                      />
                    </td>
                  ) : null}
                  <td className="max-w-0 px-4 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        selectionMode ? onToggleSelect(document.id) : handlers.onOpen(document)
                      }
                      className="flex w-full items-center gap-2.5 text-left"
                    >
                      <span className="shrink-0 rounded-lg bg-slate-100 p-1.5 text-slate-500">
                        <FileText className="h-4 w-4" />
                      </span>
                      <span className="truncate text-sm font-bold text-navy-950">{document.name}</span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-slate-600">
                    {detectedTypeLabel(document.detectedType)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <DocumentStatusBadge status={document.status} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-slate-600">
                    {formatBytes(document.sizeBytes)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-slate-500">
                    {formatRelativeTime(document.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    {selectionMode ? (
                      <span className="block text-right text-xs font-semibold text-slate-400">—</span>
                    ) : (
                      <DocumentRowActions
                        document={document}
                        handlers={handlers}
                        busy={busyIds.has(document.id)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 lg:hidden">
        {documents.map((document) => (
          <DocumentCard
            key={document.id}
            document={document}
            selectionMode={selectionMode}
            selected={selectedSet.has(document.id)}
            busy={busyIds.has(document.id)}
            handlers={handlers}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>
    </>
  );
}

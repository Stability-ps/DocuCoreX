"use client";

import type { PointerEvent } from "react";
import { FileText } from "lucide-react";
import { armMobileLongPressSelection } from "@/components/bulk-selection";
import type { DocumentRecord } from "@/lib/types";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { DocumentMobileActions, type DocumentActionHandlers } from "@/components/documents/document-actions";

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatRelativeTime(value: string): string {
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return "—";
  const diff = Math.max(0, Date.now() - target);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(value).toLocaleDateString();
}

export function detectedTypeLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Mobile document card. Checkbox appears only in selection mode. A long-press
 * enters selection mode; a plain tap opens the document. Scrolling cancels the
 * long-press (armMobileLongPressSelection tracks pointer movement), so a scroll
 * gesture never accidentally selects a card.
 */
export function DocumentCard({
  document,
  selectionMode,
  selected,
  busy,
  handlers,
  onToggleSelect,
}: {
  document: DocumentRecord;
  selectionMode: boolean;
  selected: boolean;
  busy: boolean;
  handlers: DocumentActionHandlers;
  onToggleSelect: (id: string) => void;
}) {
  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (selectionMode) return;
    armMobileLongPressSelection(event, () => onToggleSelect(document.id), { moveTolerancePx: 12 });
  }

  function handleCardTap() {
    if (selectionMode) {
      onToggleSelect(document.id);
    } else {
      handlers.onOpen(document);
    }
  }

  return (
    <article
      onPointerDown={handlePointerDown}
      className={`rounded-2xl border bg-white p-4 shadow-sm transition ${
        selected ? "border-royal-300 ring-2 ring-royal-100" : "border-slate-200"
      }`}
    >
      <div className="flex items-start gap-3">
        {selectionMode ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(document.id)}
            aria-label={`Select ${document.name}`}
            className="mt-1 h-5 w-5 shrink-0 rounded border-slate-300 accent-royal-600"
          />
        ) : (
          <div className="mt-0.5 shrink-0 rounded-xl bg-slate-100 p-2 text-slate-500">
            <FileText className="h-4 w-4" />
          </div>
        )}

        <button type="button" onClick={handleCardTap} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-bold text-navy-950">{document.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-slate-500">
            <span>{detectedTypeLabel(document.detectedType)}</span>
            <span className="text-slate-300">•</span>
            <span>{formatBytes(document.sizeBytes)}</span>
            {document.pageCount ? (
              <>
                <span className="text-slate-300">•</span>
                <span>{document.pageCount} pages</span>
              </>
            ) : null}
            <span className="text-slate-300">•</span>
            <span>{formatRelativeTime(document.updatedAt)}</span>
          </div>
        </button>

        <div className="shrink-0">
          <DocumentStatusBadge status={document.status} />
        </div>
      </div>

      {!selectionMode ? (
        <div className="mt-3">
          <DocumentMobileActions document={document} handlers={handlers} busy={busy} />
        </div>
      ) : null}
    </article>
  );
}

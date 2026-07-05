"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileOutput,
  MoreVertical,
  RefreshCcw,
  ScanSearch,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DocumentRecord } from "@/lib/types";

export type DocumentActionHandlers = {
  onOpen: (document: DocumentRecord) => void;
  onProcess: (document: DocumentRecord) => void;
  onConvert: (document: DocumentRecord) => void;
  onReview: (document: DocumentRecord) => void;
  onDownload: (document: DocumentRecord) => void;
  onExport: (document: DocumentRecord) => void;
  onDelete: (document: DocumentRecord) => void;
};

type ActionDef = {
  key: string;
  label: string;
  icon: LucideIcon;
  run: (document: DocumentRecord) => void;
  tone?: "default" | "primary" | "danger";
};

// Build the list of actions that are actually valid for a document's current
// status. Nothing inactive is ever rendered — an action only appears when it works.
function buildActions(document: DocumentRecord, handlers: DocumentActionHandlers, busy: boolean): ActionDef[] {
  const actions: ActionDef[] = [];
  const isBusy = busy || document.status === "processing" || document.status === "queued";

  actions.push({ key: "open", label: "Open", icon: Eye, run: handlers.onOpen });

  if (document.status === "review") {
    actions.push({ key: "review", label: "Review", icon: ScanSearch, run: handlers.onReview, tone: "primary" });
  }

  if (document.status === "ready") {
    actions.push({ key: "export", label: "Export", icon: FileOutput, run: handlers.onExport, tone: "primary" });
  }

  if (!isBusy && (document.status === "uploaded" || document.status === "failed")) {
    actions.push({ key: "process", label: "Process", icon: ScanSearch, run: handlers.onProcess, tone: "primary" });
  }

  if (!isBusy && document.status !== "archived") {
    actions.push({ key: "convert", label: "Convert", icon: RefreshCcw, run: handlers.onConvert });
  }

  actions.push({ key: "download", label: "Download", icon: Download, run: handlers.onDownload });
  actions.push({ key: "delete", label: "Delete", icon: Trash2, run: handlers.onDelete, tone: "danger" });

  return actions;
}

function toneClasses(tone: ActionDef["tone"]) {
  if (tone === "primary") return "border-royal-200 bg-royal-50 text-royal-700 hover:bg-royal-100";
  if (tone === "danger") return "border-rose-200 bg-white text-rose-600 hover:bg-rose-50";
  return "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
}

/**
 * Desktop inline action row: shows the first N actions as buttons and the rest
 * inside an overflow menu. Used inside the document table.
 */
export function DocumentRowActions({
  document,
  handlers,
  busy = false,
  inlineCount = 2,
}: {
  document: DocumentRecord;
  handlers: DocumentActionHandlers;
  busy?: boolean;
  inlineCount?: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actions = buildActions(document, handlers, busy);
  const inline = actions.slice(0, inlineCount);
  const overflow = actions.slice(inlineCount);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  return (
    <div className="flex items-center justify-end gap-1.5">
      {inline.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={() => action.run(document)}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-bold transition ${toneClasses(action.tone)}`}
        >
          <action.icon className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">{action.label}</span>
        </button>
      ))}
      {overflow.length ? (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="More actions"
            className="inline-flex min-h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              {overflow.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    action.run(document);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold ${
                    action.tone === "danger" ? "text-rose-600 hover:bg-rose-50" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <action.icon className="h-4 w-4" />
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mobile action grid: renders every valid action as a full tap target. No
 * overflow menu on mobile — everything is visible and thumb-friendly.
 */
export function DocumentMobileActions({
  document,
  handlers,
  busy = false,
}: {
  document: DocumentRecord;
  handlers: DocumentActionHandlers;
  busy?: boolean;
}) {
  const actions = buildActions(document, handlers, busy);
  return (
    <div className="grid grid-cols-3 gap-2">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={() => action.run(document)}
          className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-bold transition ${toneClasses(action.tone)}`}
        >
          <action.icon className="h-3.5 w-3.5" />
          {action.label}
        </button>
      ))}
    </div>
  );
}

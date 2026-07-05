"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileWarning, Loader2, Maximize2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";

// The single, platform-wide document viewer. Every "View" / preview action —
// Documents, the Statement Review Workspace, and any attachment preview — renders
// THIS component. It handles PDFs, images and other file types, with an in-app
// full-screen overlay (never browser fullscreen, which froze the app), zoom,
// centred rotation, download, and loading / error states.

export type DocumentViewerKind = "pdf" | "image" | "other";

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-royal-700"
    >
      {children}
    </button>
  );
}

export function DocumentViewer({
  sourceUrl,
  fileName = "document",
  kind = "pdf",
  className = "",
  minHeightClass = "min-h-[520px]",
}: {
  sourceUrl: string;
  fileName?: string;
  kind?: DocumentViewerKind;
  className?: string;
  minHeightClass?: string;
}) {
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(kind === "other" ? "ready" : "loading");
  const [fullscreen, setFullscreen] = useState(false);

  const previewable = kind === "pdf" || kind === "image";

  const checkAvailability = useCallback(async () => {
    if (!previewable) {
      setStatus("ready");
      return;
    }
    setStatus("loading");
    try {
      const response = await fetch(sourceUrl, { method: "GET", redirect: "follow" });
      setStatus(response.ok ? "ready" : "error");
    } catch {
      setStatus("error");
    }
  }, [sourceUrl, previewable]);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // ESC closes the in-app overlay (never uses browser fullscreen, which froze).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const frameSrc = `${sourceUrl}#page=${page}&view=Fit`;
  const landscape = rotate % 180 !== 0;
  const transformStyle = {
    width: landscape ? "70vh" : "100%",
    height: landscape ? "70vw" : "100%",
    maxWidth: landscape ? "100%" : "880px",
    transform: `rotate(${rotate}deg) scale(${scale})`,
    transformOrigin: "center center" as const,
  };

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
      <div className="flex items-center gap-1">
        {kind === "pdf" ? (
          <>
            <ToolButton label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ‹
            </ToolButton>
            <span className="min-w-14 text-center text-xs font-bold text-slate-600">Page {page}</span>
            <ToolButton label="Next page" onClick={() => setPage((p) => p + 1)}>
              ›
            </ToolButton>
          </>
        ) : (
          <span className="max-w-[220px] truncate px-1 text-xs font-bold text-slate-600" title={fileName}>
            {fileName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {previewable ? (
          <>
            <ToolButton label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))}>
              <ZoomOut className="h-4 w-4" />
            </ToolButton>
            <span className="min-w-12 text-center text-xs font-bold text-slate-600">{Math.round(scale * 100)}%</span>
            <ToolButton label="Zoom in" onClick={() => setScale((s) => Math.min(2.5, +(s + 0.1).toFixed(2)))}>
              <ZoomIn className="h-4 w-4" />
            </ToolButton>
            <ToolButton label="Fit" onClick={() => { setScale(1); setRotate(0); }}>
              Fit
            </ToolButton>
            <ToolButton
              label="Rotate"
              onClick={() => {
                setScale(1);
                setRotate((r) => (r + 90) % 360);
              }}
            >
              <RotateCw className="h-4 w-4" />
            </ToolButton>
          </>
        ) : null}
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-royal-700"
          aria-label="Download"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        {fullscreen ? (
          <button
            onClick={() => setFullscreen(false)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-royal-700"
            aria-label="Close full screen"
          >
            <X className="h-4 w-4" /> Close
          </button>
        ) : (
          <ToolButton label="Full screen" onClick={() => setFullscreen(true)}>
            <Maximize2 className="h-4 w-4" />
          </ToolButton>
        )}
      </div>
    </div>
  );

  const fallback = (
    <div className="flex h-full min-h-[440px] flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="h-8 w-8 text-slate-300" />
      <p className="text-sm font-bold text-slate-600">Preview not available for this file type</p>
      <a
        href={sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700"
      >
        Download to view
      </a>
    </div>
  );

  // The stage rotates the document around its centre and keeps it inside the
  // scrollable viewer at every angle (0/90/180/270) — never pushed out.
  const stage = (heightClass: string) => (
    <div className={`relative flex-1 overflow-auto bg-slate-100 ${heightClass}`}>
      {!previewable ? (
        fallback
      ) : status === "loading" ? (
        <div className="flex h-full min-h-[440px] items-center justify-center text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2 text-sm font-bold">Loading preview…</span>
        </div>
      ) : status === "error" ? (
        <div className="flex h-full min-h-[440px] flex-col items-center justify-center gap-3 p-6 text-center">
          <FileWarning className="h-8 w-8 text-amber-500" />
          <p className="text-sm font-bold text-slate-600">Preview unavailable</p>
          <div className="flex items-center gap-2">
            <button onClick={() => void checkAvailability()} className="rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700">
              Retry
            </button>
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
              Download
            </a>
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-[440px] items-center justify-center overflow-auto p-3">
          {kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sourceUrl} alt={fileName} className="rounded border border-slate-200 bg-white object-contain" style={transformStyle} />
          ) : (
            <iframe key={page} title={fileName} src={frameSrc} className="rounded border border-slate-200 bg-white" style={transformStyle} />
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <section className={`flex ${minHeightClass} flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
        {toolbar}
        {stage("")}
      </section>

      {fullscreen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/90 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Document full screen">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            {toolbar}
            {stage("min-h-0")}
          </div>
        </div>
      ) : null}
    </>
  );
}

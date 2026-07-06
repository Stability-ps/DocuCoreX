"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileWarning, Loader2, Maximize2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";

// The single, platform-wide document viewer. Every "View" / preview action —
// Documents, the Statement Review Workspace, and any attachment preview — renders
// THIS component. It handles PDFs, images and other file types, with an in-app
// full-screen overlay (never browser fullscreen, which froze the app), zoom,
// centred rotation, download, and clear loading / error states.
//
// Preview and download use SEPARATE URLs: `sourceUrl` must be an INLINE-serving
// URL (Content-Disposition: inline) so the browser renders it; `downloadUrl`
// (defaults to sourceUrl) is used only by the Download button.

export type DocumentViewerKind = "pdf" | "image" | "other";

const IS_DEV = process.env.NODE_ENV !== "production";
const RENDER_TIMEOUT_MS = 15000;

type Diagnostics = {
  previewUrl: string;
  renderer: string;
  availabilityChecked: boolean;
  documentLoaded: boolean;
  currentPage: number;
  renderStarted: boolean;
  renderCompleted: boolean;
  renderFailed: boolean;
};

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
  downloadUrl,
  fileName = "document",
  kind = "pdf",
  className = "",
  minHeightClass = "min-h-[520px]",
}: {
  sourceUrl: string;
  downloadUrl?: string;
  fileName?: string;
  kind?: DocumentViewerKind;
  className?: string;
  minHeightClass?: string;
}) {
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(kind === "other" ? "ready" : "loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const previewable = kind === "pdf" || kind === "image";
  const resolvedDownloadUrl = downloadUrl ?? sourceUrl;

  const [diag, setDiag] = useState<Diagnostics>({
    previewUrl: sourceUrl,
    renderer: kind === "image" ? "browser image" : "browser (native PDF)",
    availabilityChecked: false,
    documentLoaded: false,
    currentPage: 1,
    renderStarted: false,
    renderCompleted: false,
    renderFailed: false,
  });

  const startCheck = useCallback(async () => {
    if (!previewable) {
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setErrorMsg(null);
    setDiag((d) => ({ ...d, previewUrl: sourceUrl, renderStarted: true, renderCompleted: false, renderFailed: false, documentLoaded: false }));
    // Fast-fail on an explicit 4xx/5xx (missing file / unauthorized). A network
    // or CORS failure is non-fatal — fall through and let the frame try to load.
    try {
      const response = await fetch(sourceUrl, { method: "HEAD" });
      setDiag((d) => ({ ...d, availabilityChecked: true }));
      if (!response.ok) {
        setStatus("error");
        setErrorMsg(`${response.status} ${response.statusText || "Unable to load document"}`.trim());
        setDiag((d) => ({ ...d, renderFailed: true }));
        return;
      }
      // A page/error body served where a document is expected (e.g. an HTML
      // error page) must surface an error, not a blank or garbled frame.
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (kind === "pdf" && contentType.includes("text/html")) {
        setStatus("error");
        setErrorMsg("The preview URL returned a page instead of a document.");
        setDiag((d) => ({ ...d, renderFailed: true }));
        return;
      }
    } catch {
      setDiag((d) => ({ ...d, availabilityChecked: true }));
    }
  }, [sourceUrl, previewable, kind]);

  // Run the availability check on mount / when the source changes / on retry.
  useEffect(() => {
    void startCheck();
  }, [startCheck, frameKey]);

  // Timeout fallback: if the frame never signals load, surface an error instead
  // of leaving a blank viewer.
  useEffect(() => {
    if (status !== "loading" || !previewable) return;
    timerRef.current = setTimeout(() => {
      setStatus((current) => (current === "loading" ? "error" : current));
      setErrorMsg((current) => current ?? "The document did not render in time.");
      setDiag((d) => ({ ...d, renderFailed: true }));
    }, RENDER_TIMEOUT_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [status, previewable, frameKey]);

  // ESC closes the in-app overlay (never uses browser fullscreen, which froze).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  function retry() {
    setFrameKey((k) => k + 1);
  }

  function onFrameLoad() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus("ready");
    setDiag((d) => ({ ...d, documentLoaded: true, renderCompleted: true }));
  }

  function onFrameError() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus("error");
    setErrorMsg((current) => current ?? "The document could not be rendered.");
    setDiag((d) => ({ ...d, renderFailed: true }));
  }

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
            <ToolButton
              label="Previous page"
              onClick={() => {
                const next = Math.max(1, page - 1);
                setPage(next);
                setDiag((d) => ({ ...d, currentPage: next }));
              }}
            >
              ‹
            </ToolButton>
            <span className="min-w-14 text-center text-xs font-bold text-slate-600">Page {page}</span>
            <ToolButton
              label="Next page"
              onClick={() => {
                const next = page + 1;
                setPage(next);
                setDiag((d) => ({ ...d, currentPage: next }));
              }}
            >
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
          href={resolvedDownloadUrl}
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

  const errorCard = (title: string) => (
    <div className="flex h-full min-h-[440px] flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="h-8 w-8 text-amber-500" />
      <p className="text-sm font-bold text-slate-700">{title}</p>
      {errorMsg ? <p className="max-w-md text-xs font-semibold text-slate-400">{errorMsg}</p> : null}
      <div className="flex items-center gap-2">
        <button onClick={retry} className="rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700">
          Retry
        </button>
        <a href={resolvedDownloadUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
          Download Original
        </a>
      </div>
    </div>
  );

  // The stage rotates the document around its centre and keeps it inside the
  // scrollable viewer at every angle (0/90/180/270) — never pushed out.
  const stage = (heightClass: string) => (
    <div className={`relative flex-1 overflow-auto bg-slate-100 ${heightClass}`}>
      {!previewable ? (
        errorCard("Preview not available for this file type")
      ) : status === "error" ? (
        errorCard("Unable to preview document")
      ) : (
        <>
          {status === "loading" ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-100/80 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2 text-sm font-bold">Loading preview…</span>
            </div>
          ) : null}
          <div className="flex h-full min-h-[440px] items-center justify-center overflow-auto p-3">
            {kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={frameKey}
                src={sourceUrl}
                alt={fileName}
                onLoad={onFrameLoad}
                onError={onFrameError}
                className="rounded border border-slate-200 bg-white object-contain"
                style={transformStyle}
              />
            ) : (
              <iframe
                key={`${frameKey}-${page}`}
                title={fileName}
                src={frameSrc}
                onLoad={onFrameLoad}
                onError={onFrameError}
                className="rounded border border-slate-200 bg-white"
                style={transformStyle}
              />
            )}
          </div>
        </>
      )}
    </div>
  );

  const diagnosticsPanel = IS_DEV ? (
    <div className="border-t border-slate-100 bg-slate-50 px-3 py-1.5 text-[10px] font-mono leading-relaxed text-slate-500">
      <span className="font-bold text-slate-600">viewer diagnostics</span> · renderer={diag.renderer} · availabilityChecked={String(diag.availabilityChecked)} ·
      documentLoaded={String(diag.documentLoaded)} · page={diag.currentPage} · renderStarted={String(diag.renderStarted)} · renderCompleted=
      {String(diag.renderCompleted)} · renderFailed={String(diag.renderFailed)} · url={diag.previewUrl}
    </div>
  ) : null;

  return (
    <>
      <section className={`flex ${minHeightClass} flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
        {toolbar}
        {stage("")}
        {diagnosticsPanel}
      </section>

      {fullscreen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/90 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Document full screen">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            {toolbar}
            {stage("min-h-0")}
            {diagnosticsPanel}
          </div>
        </div>
      ) : null}
    </>
  );
}

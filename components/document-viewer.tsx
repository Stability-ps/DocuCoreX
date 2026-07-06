"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileWarning, Loader2, Maximize2, RotateCw, Search, X, ZoomIn, ZoomOut } from "lucide-react";

// The single, platform-wide document viewer. Renders PDFs on a <canvas> via
// pdf.js (no iframe), with fit-width by default, zoom, page navigation, text
// search, rotation, download, an in-app full-screen overlay, and a clear error
// fallback instead of a blank preview. Images render inline; other types offer a
// download. Preview and download use separate URLs.

export type DocumentViewerKind = "pdf" | "image" | "other";

// Minimal structural types for the pdf.js objects we use (avoids fragile deep
// type imports across pdfjs-dist versions).
type PdfViewport = { width: number; height: number };
type PdfRenderTask = { promise: Promise<void>; cancel: () => void };
type PdfPage = {
  getViewport: (options: { scale: number; rotation?: number }) => PdfViewport;
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
  render: (options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; transform?: number[] }) => PdfRenderTask;
};
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage>; destroy: () => Promise<void> };

// Load pdf.js on the client only and point it at the correct Next.js worker URL.
type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-royal-700 disabled:opacity-40"
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
  const resolvedDownloadUrl = downloadUrl ?? sourceUrl;
  const [fullscreen, setFullscreen] = useState(false);

  // ESC closes the in-app overlay (never browser fullscreen).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const viewer = (
    <PdfCanvasViewer
      key={fullscreen ? "fs" : "inline"}
      sourceUrl={sourceUrl}
      downloadUrl={resolvedDownloadUrl}
      fileName={fileName}
      kind={kind}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((v) => !v)}
    />
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/90 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Document full screen">
        <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">{viewer}</div>
      </div>
    );
  }
  return <section className={`flex ${minHeightClass} flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{viewer}</section>;
}

function PdfCanvasViewer({
  sourceUrl,
  downloadUrl,
  fileName,
  kind,
  fullscreen,
  onToggleFullscreen,
}: {
  sourceUrl: string;
  downloadUrl: string;
  fileName: string;
  kind: DocumentViewerKind;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const textCacheRef = useRef<Map<number, string>>(new Map());

  const [status, setStatus] = useState<"loading" | "ready" | "error">(kind === "pdf" ? "loading" : "ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [rotate, setRotate] = useState(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [matchPages, setMatchPages] = useState<number[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [searching, setSearching] = useState(false);

  // ── Load the PDF document ──────────────────────────────────────────────────
  useEffect(() => {
    if (kind !== "pdf") return;
    let cancelled = false;
    setStatus("loading");
    setErrorMsg(null);
    textCacheRef.current.clear();
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const doc = (await pdfjs.getDocument({ url: sourceUrl }).promise) as unknown as PdfDoc;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setPage(1);
        setStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setErrorMsg(error instanceof Error ? error.message : "The document could not be rendered.");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      void pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [sourceUrl, kind, reloadKey]);

  // ── Render the current page to the canvas ──────────────────────────────────
  const renderPage = useCallback(async () => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    try {
      renderTaskRef.current?.cancel();
      const pdfPage = await pdf.getPage(page);
      const unscaled = pdfPage.getViewport({ scale: 1, rotation: rotate });
      let renderScale = scale;
      if (fitMode) {
        const width = (containerRef.current?.clientWidth ?? 800) - 24;
        renderScale = Math.max(0.15, width / unscaled.width);
      }
      const viewport = pdfPage.getViewport({ scale: renderScale, rotation: rotate });
      const outputScale = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
      const task = pdfPage.render({ canvas, canvasContext: context, viewport, transform });
      renderTaskRef.current = task;
      await task.promise;
      setZoomPercent(Math.round(renderScale * 100));
    } catch (error) {
      // Cancelled renders throw a RenderingCancelledException — ignore those.
      if (error && typeof error === "object" && "name" in error && (error as { name: string }).name === "RenderingCancelledException") return;
      setErrorMsg(error instanceof Error ? error.message : "Failed to render this page.");
      setStatus("error");
    }
  }, [page, scale, fitMode, rotate]);

  useEffect(() => {
    if (status === "ready" && kind === "pdf") void renderPage();
  }, [status, kind, renderPage]);

  // Re-fit on container resize (only in fit-width mode).
  useEffect(() => {
    if (kind !== "pdf" || !fitMode) return;
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (status === "ready") void renderPage();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind, fitMode, status, renderPage]);

  function goToPage(next: number) {
    setPage((current) => Math.min(numPages || 1, Math.max(1, next || current)));
  }
  function zoomTo(next: number) {
    setFitMode(false);
    setScale(Math.min(4, Math.max(0.25, +next.toFixed(2))));
  }
  function fitWidth() {
    setFitMode(true);
    setRotate(0);
  }

  // ── Text search: jump to pages that contain the query ─────────────────────
  const runSearch = useCallback(async () => {
    const query = search.trim().toLowerCase();
    if (!query || !pdfRef.current) {
      setMatchPages([]);
      return;
    }
    setSearching(true);
    try {
      const pdf = pdfRef.current;
      const found: number[] = [];
      for (let p = 1; p <= pdf.numPages; p += 1) {
        let text = textCacheRef.current.get(p);
        if (text === undefined) {
          const content = await pdf.getPage(p).then((pg) => pg.getTextContent());
          text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").toLowerCase();
          textCacheRef.current.set(p, text);
        }
        if (text.includes(query)) found.push(p);
      }
      setMatchPages(found);
      setMatchIdx(0);
      if (found.length) goToPage(found[0]);
    } finally {
      setSearching(false);
    }
  }, [search]);

  function stepMatch(direction: 1 | -1) {
    if (!matchPages.length) return;
    const next = (matchIdx + direction + matchPages.length) % matchPages.length;
    setMatchIdx(next);
    goToPage(matchPages[next]);
  }

  const previewable = kind === "pdf" || kind === "image";

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
      <div className="flex items-center gap-1">
        {kind === "pdf" ? (
          <>
            <ToolButton label="Previous page" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
              <ChevronLeft className="h-4 w-4" />
            </ToolButton>
            <span className="min-w-16 text-center text-xs font-bold text-slate-600">{numPages ? `${page} / ${numPages}` : "—"}</span>
            <ToolButton label="Next page" onClick={() => goToPage(page + 1)} disabled={page >= numPages}>
              <ChevronRight className="h-4 w-4" />
            </ToolButton>
          </>
        ) : (
          <span className="max-w-[220px] truncate px-1 text-xs font-bold text-slate-600" title={fileName}>
            {fileName}
          </span>
        )}
      </div>

      {kind === "pdf" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
          className="flex items-center gap-1"
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              className="h-8 w-28 rounded-md border border-slate-200 pl-7 pr-2 text-xs font-semibold outline-none focus:border-royal-300 sm:w-40"
              aria-label="Search document text"
            />
          </div>
          {matchPages.length ? (
            <>
              <span className="text-[11px] font-bold text-slate-500">{matchIdx + 1}/{matchPages.length}</span>
              <ToolButton label="Previous match" onClick={() => stepMatch(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </ToolButton>
              <ToolButton label="Next match" onClick={() => stepMatch(1)}>
                <ChevronRight className="h-4 w-4" />
              </ToolButton>
            </>
          ) : searching ? (
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
          ) : null}
        </form>
      ) : null}

      <div className="flex items-center gap-1">
        {previewable ? (
          <>
            <ToolButton label="Zoom out" onClick={() => zoomTo((fitMode ? zoomPercent / 100 : scale) - 0.2)}>
              <ZoomOut className="h-4 w-4" />
            </ToolButton>
            <span className="min-w-12 text-center text-xs font-bold text-slate-600">{zoomPercent}%</span>
            <ToolButton label="Zoom in" onClick={() => zoomTo((fitMode ? zoomPercent / 100 : scale) + 0.2)}>
              <ZoomIn className="h-4 w-4" />
            </ToolButton>
            <ToolButton label="Fit width" onClick={fitWidth}>
              Fit
            </ToolButton>
            {kind === "pdf" ? (
              <ToolButton label="Rotate" onClick={() => setRotate((r) => (r + 90) % 360)}>
                <RotateCw className="h-4 w-4" />
              </ToolButton>
            ) : null}
          </>
        ) : null}
        <a href={downloadUrl} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-royal-700" aria-label="Download" title="Download">
          <Download className="h-4 w-4" />
        </a>
        {fullscreen ? (
          <button onClick={onToggleFullscreen} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-royal-700" aria-label="Close full screen">
            <X className="h-4 w-4" /> Close
          </button>
        ) : (
          <ToolButton label="Full screen" onClick={onToggleFullscreen}>
            <Maximize2 className="h-4 w-4" />
          </ToolButton>
        )}
      </div>
    </div>
  );

  const errorCard = (
    <div className="flex h-full min-h-[440px] flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="h-8 w-8 text-amber-500" />
      <p className="text-sm font-bold text-slate-700">Unable to display document</p>
      {errorMsg ? <p className="max-w-md break-words text-xs font-semibold text-slate-400">{errorMsg}</p> : null}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setErrorMsg(null);
            setStatus(kind === "pdf" ? "loading" : "ready");
            setReloadKey((k) => k + 1);
          }}
          className="rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700"
        >
          Retry
        </button>
        <a href={downloadUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">
          Download Original
        </a>
      </div>
    </div>
  );

  return (
    <>
      {toolbar}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto bg-slate-50">
        {kind === "other" ? (
          errorCard
        ) : kind === "image" ? (
          <div className="flex min-h-full items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sourceUrl} alt={fileName} className="max-w-full rounded border border-slate-200 bg-white object-contain" onError={() => { setErrorMsg("The image could not be loaded."); setStatus("error"); }} />
          </div>
        ) : status === "error" ? (
          errorCard
        ) : (
          <>
            {status === "loading" ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50/80 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" /> <span className="ml-2 text-sm font-bold">Loading document…</span>
              </div>
            ) : null}
            <div className="flex min-h-full justify-center p-3">
              <canvas ref={canvasRef} className="h-fit rounded border border-slate-200 bg-white shadow-sm" />
            </div>
          </>
        )}
      </div>
    </>
  );
}

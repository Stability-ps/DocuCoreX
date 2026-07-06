"use client";

import { useState } from "react";
import { Download, FileWarning, Maximize2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";

// Documents-only preview viewer. Tuned so the PDF fits the container WIDTH by
// default (readable immediately) rather than the shared viewer's fit-whole-page
// behaviour. Preview renders inline (previewUrl); the Download button uses the
// attachment endpoint (downloadUrl) — preview never downloads.

export type DocumentPreviewKind = "pdf" | "image" | "other";

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
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

export function DocumentPreview({
  previewUrl,
  downloadUrl,
  name,
  kind,
}: {
  previewUrl: string;
  downloadUrl: string;
  name: string;
  kind: DocumentPreviewKind;
}) {
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [failed, setFailed] = useState(false);

  const previewable = kind === "pdf" || kind === "image";
  // Fit Width by default: FitH fits the page width to the iframe.
  const frameSrc = `${previewUrl}#view=FitH&toolbar=0`;

  const fitWidth = () => {
    setScale(1);
    setRotate(0);
  };

  const transformStyle = {
    transform: `rotate(${rotate}deg) scale(${scale})`,
    transformOrigin: "center center" as const,
  };

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
      <span className="max-w-[240px] truncate px-1 text-xs font-bold text-slate-600" title={name}>
        {name}
      </span>
      <div className="flex items-center gap-1">
        {previewable ? (
          <>
            <Tool label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))}>
              <ZoomOut className="h-4 w-4" />
            </Tool>
            <span className="min-w-12 text-center text-xs font-bold text-slate-600">{Math.round(scale * 100)}%</span>
            <Tool label="Zoom in" onClick={() => setScale((s) => Math.min(3, +(s + 0.1).toFixed(2)))}>
              <ZoomIn className="h-4 w-4" />
            </Tool>
            <Tool label="Fit width" onClick={fitWidth}>
              Fit
            </Tool>
            <Tool label="Rotate" onClick={() => { setScale(1); setRotate((r) => (r + 90) % 360); }}>
              <RotateCw className="h-4 w-4" />
            </Tool>
          </>
        ) : null}
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-royal-700"
          aria-label="Download"
          title="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        {fullscreen ? (
          <button onClick={() => setFullscreen(false)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-100 hover:text-royal-700" aria-label="Close full screen">
            <X className="h-4 w-4" /> Close
          </button>
        ) : (
          <Tool label="Full screen" onClick={() => setFullscreen(true)}>
            <Maximize2 className="h-4 w-4" />
          </Tool>
        )}
      </div>
    </div>
  );

  const errorCard = (title: string) => (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="h-8 w-8 text-amber-500" />
      <p className="text-sm font-bold text-slate-700">{title}</p>
      <a href={downloadUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-royal-600 px-3 py-2 text-sm font-bold text-white hover:bg-royal-700">
        Download Original
      </a>
    </div>
  );

  // Light background (avoids a heavy dark surround); the page fills the width so
  // the browser PDF chrome margins stay minimal.
  const stage = (heightClass: string) => (
    <div className={`relative flex-1 overflow-auto bg-slate-50 ${heightClass}`}>
      {!previewable || failed ? (
        errorCard(!previewable ? "Preview not available for this file type" : "Unable to preview document")
      ) : kind === "image" ? (
        <div className="flex min-h-full items-center justify-center overflow-auto p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={name} onError={() => setFailed(true)} className="max-w-full rounded border border-slate-200 bg-white object-contain" style={transformStyle} />
        </div>
      ) : (
        <iframe
          title={name}
          src={frameSrc}
          onError={() => setFailed(true)}
          className="h-full w-full border-0 bg-white"
          style={transformStyle}
        />
      )}
    </div>
  );

  return (
    <>
      {/* Fill the remaining viewport height after the app header, document info
          and tabs; responsive to window resize via viewport units. */}
      <section className="flex h-[calc(100vh-13rem)] max-h-[90vh] min-h-[78vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
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

"use client";

import { useMemo, useState } from "react";
import { DocumentViewer } from "@/components/document-viewer";

const SAMPLE_PDF = "https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf";

export function ViewerGeometryHarness() {
  const [selectedPage, setSelectedPage] = useState(1);
  const jumpToPage = useMemo(() => ({ page: selectedPage, nonce: Date.now() }), [selectedPage]);

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="mx-auto flex h-[calc(100vh-2rem)] max-w-[1400px] gap-3">
        <section className="h-full min-w-0 flex-1">
          <DocumentViewer sourceUrl={SAMPLE_PDF} fileName="sample.pdf" kind="pdf" jumpToPage={jumpToPage} minHeightClass="h-full min-h-0" />
        </section>
        <aside className="w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <h1 className="text-sm font-bold">Viewer Geometry Harness</h1>
          <p className="mt-1 text-xs text-slate-500">Use these buttons to mimic transaction source-page jumps.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[1, 2, 3, 4].map((page) => (
              <button
                key={page}
                type="button"
                onClick={() => setSelectedPage(page)}
                className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Jump to page {page}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}

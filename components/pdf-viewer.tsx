"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize2, Printer, RotateCw, Search, ZoomIn, ZoomOut } from "lucide-react";

const transactions = Array.from({ length: 12 }).map((_, index) => ({
  date: `2026-06-${String(index + 10).padStart(2, "0")}`,
  description: `Supplier payment reference ${1000 + index}`,
  debit: `R ${(index * 740 + 1280).toLocaleString()}`,
  balance: `R ${(468781 - index * 1280).toLocaleString()}`,
}));

export function PdfViewer() {
  const [zoom, setZoom] = useState(100);
  const [page, setPage] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [search, setSearch] = useState("");
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pages = [1, 2, 3, 4, 5, 6];
  const pageCount = 42;
  const searchHits = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return transactions;
    return transactions.filter((transaction) =>
      [transaction.date, transaction.description, transaction.debit, transaction.balance].join(" ").toLowerCase().includes(normalized),
    );
  }, [search]);

  function setBoundedPage(value: number) {
    setPage(Math.min(pageCount, Math.max(1, value || 1)));
  }

  async function enterFullscreen() {
    await viewerRef.current?.requestFullscreen?.();
  }

  function printDocument() {
    window.print();
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-white p-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setZoom((value) => Math.max(50, value - 10))} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Zoom out">
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-black text-slate-600">{zoom}%</span>
          <button onClick={() => setZoom((value) => Math.min(200, value + 10))} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Zoom in">
            <ZoomIn className="h-4 w-4" />
          </button>
          <button onClick={() => setRotation((value) => (value + 90) % 360)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Rotate">
            <RotateCw className="h-4 w-4" />
          </button>
          <button onClick={() => setBoundedPage(page - 1)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            <span className="text-xs font-bold text-slate-500">Page</span>
            <input
              value={page}
              onChange={(event) => setBoundedPage(Number(event.target.value))}
              className="w-9 bg-transparent text-center text-sm font-black outline-none"
            />
            <span className="text-xs font-bold text-slate-500">/ {pageCount}</span>
          </div>
          <button onClick={() => setBoundedPage(page + 1)} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Next page">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              className="w-36 bg-transparent text-sm font-semibold outline-none"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search PDF"
              value={search}
            />
          </div>
          <button onClick={enterFullscreen} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Fullscreen">
            <Maximize2 className="h-4 w-4" />
          </button>
          <a href="/api/download-file/download_xlsx_statement_q2" className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Download">
            <Download className="h-4 w-4" />
          </a>
          <button onClick={printDocument} className="rounded-xl border border-slate-200 p-2 text-slate-600 hover:text-royal-700" title="Print">
            <Printer className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={viewerRef} className="grid min-h-[680px] bg-slate-100 lg:grid-cols-[132px_1fr]">
        <aside className="hidden border-r border-slate-200 bg-white p-3 lg:block">
          <div className="space-y-3">
            {pages.map((thumb) => (
              <button
                key={thumb}
                onClick={() => setPage(thumb)}
                className={`w-full rounded-2xl border p-2 text-left transition ${
                  page === thumb ? "border-royal-300 bg-royal-50" : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="aspect-[3/4] rounded-xl bg-white shadow-inner">
                  <div className="space-y-1 p-2">
                    <div className="h-2 rounded-full bg-slate-200" />
                    <div className="h-2 w-3/4 rounded-full bg-slate-100" />
                    <div className="mt-2 h-8 rounded-lg bg-royal-100" />
                  </div>
                </div>
                <p className="mt-2 text-center text-xs font-black text-slate-500">{thumb}</p>
              </button>
            ))}
          </div>
        </aside>
        <div className="flex items-start justify-center overflow-auto p-5">
          <div
            className="w-full max-w-[760px] origin-top rounded-2xl bg-white p-8 shadow-soft transition"
            style={{ transform: `scale(${zoom / 100}) rotate(${rotation}deg)` }}
          >
            <div className="mb-8 flex items-start justify-between border-b border-slate-200 pb-6">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Business Statement</p>
                <h3 className="mt-2 text-2xl font-black text-navy-950">Account Activity Summary</h3>
              </div>
              <div className="rounded-2xl bg-royal-50 px-4 py-3 text-right">
                <p className="text-xs font-black text-royal-700">Page {page}</p>
                <p className="text-sm font-black text-navy-950">R 468,781.29</p>
              </div>
            </div>
            <div className="grid gap-3">
              {searchHits.map((transaction) => (
                <div key={`${transaction.date}-${transaction.description}`} className="grid grid-cols-[0.7fr_1.6fr_0.8fr_0.8fr] gap-3 border-b border-slate-100 pb-3 text-sm">
                  <span className="font-bold text-slate-500">{transaction.date}</span>
                  <span className={search ? "font-black text-royal-700" : "font-semibold text-navy-950"}>{transaction.description}</span>
                  <span className="text-right font-bold text-rose-600">{transaction.debit}</span>
                  <span className="text-right font-black text-navy-950">{transaction.balance}</span>
                </div>
              ))}
              {searchHits.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-black text-slate-500">No matches on this page</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

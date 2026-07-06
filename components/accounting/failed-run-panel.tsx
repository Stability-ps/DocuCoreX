"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import type { AccountingStatementRun } from "@/lib/accounting/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900/95 p-3 text-[11px] leading-relaxed text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// Shown when a statement run has failed. Surfaces the REAL reason instead of just
// "Failed 0%": the error message, the last processing step, selected parser,
// detected PDF type, and the full parserDebug + OCR debug — plus Retry / Force
// Reprocess. Failed runs are never auto-deleted; this is how the user recovers.
export function FailedRunPanel({
  run,
  onRetry,
  busy,
}: {
  run: AccountingStatementRun;
  onRetry: () => void;
  busy: boolean;
}) {
  const [showDebug, setShowDebug] = useState(false);

  const parserDebug = asRecord(run.parserDebug);
  const ocrDebug = parserDebug ? asRecord(parserDebug.ocr) : null;
  const reasonNoTransactions = typeof parserDebug?.reason_no_transactions === "string" ? (parserDebug.reason_no_transactions as string) : null;
  const selectedParser = run.parserMethod ?? (typeof parserDebug?.selected_parser === "string" ? (parserDebug.selected_parser as string) : null);
  const detectedPdfType = run.detectedPdfType ?? (typeof parserDebug?.detected_pdf_type === "string" ? (parserDebug.detected_pdf_type as string) : null);
  const warnings = Array.isArray(run.extractionWarnings) ? run.extractionWarnings : [];

  const facts: Array<[string, string]> = [
    ["Last processing step", run.processingStep ?? "—"],
    ["Selected parser", selectedParser ?? "—"],
    ["Detected PDF type", detectedPdfType ?? "—"],
    ["OCR used", run.ocrUsed == null ? "—" : run.ocrUsed ? "Yes" : "No"],
  ];

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-4 sm:p-5" role="alert">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 shrink-0 text-rose-600" />
            <h3 className="text-lg font-semibold text-rose-900">Processing failed</h3>
          </div>
          <p className="mt-2 break-words text-sm font-semibold text-rose-800">{run.error || "The statement could not be processed."}</p>
          {reasonNoTransactions && reasonNoTransactions !== run.error ? (
            <p className="mt-1 break-words text-xs font-semibold text-rose-700">{reasonNoTransactions}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-rose-600 px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-rose-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Reprocessing…" : "Retry / Force Reprocess"}
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[10px] font-black uppercase tracking-wide text-rose-500">{label}</dt>
            <dd className="truncate text-sm font-bold text-rose-900" title={value}>{value}</dd>
          </div>
        ))}
      </dl>

      {run.routeReason ? <p className="mt-3 break-words text-xs font-semibold text-rose-700">Route: {run.routeReason}</p> : null}

      {warnings.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs font-semibold text-rose-700">
          {warnings.map((warning, index) => (
            <li key={`${warning}-${index}`} className="break-words">{warning}</li>
          ))}
        </ul>
      ) : null}

      {parserDebug || ocrDebug ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowDebug((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-black text-rose-700 hover:text-rose-900"
            aria-expanded={showDebug}
          >
            <ChevronDown className={`h-4 w-4 transition ${showDebug ? "rotate-180" : ""}`} />
            {showDebug ? "Hide technical details" : "View error details (parserDebug + OCR debug)"}
          </button>
          {showDebug ? (
            <div className="mt-2 space-y-3">
              {ocrDebug ? (
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wide text-rose-500">OCR debug</p>
                  <JsonBlock value={ocrDebug} />
                </div>
              ) : null}
              {parserDebug ? (
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wide text-rose-500">Parser debug</p>
                  <JsonBlock value={parserDebug} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

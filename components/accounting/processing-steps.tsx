"use client";

import { useEffect, useState } from "react";
import {
  LONG_PROCESSING_NOTICE,
  LONG_PROCESSING_THRESHOLD_MS,
  STALE_PROCESSING_NOTICE,
  STALE_PROCESSING_THRESHOLD_MS,
} from "@/lib/pdf/processingSteps";
import {
  ACCOUNTING_PROCESSING_STAGE_LABELS,
  ACCOUNTING_PROCESSING_STAGE_ORDER,
  normalizeAccountingProcessingStage,
} from "@/lib/accounting/processing-stage";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Live processing stepper shown while a statement is being processed. OCR is
// extraction detail, not a universal lifecycle stage.
export function ProcessingSteps({ step, startedAt, updatedAt, ocrUsed }: { step?: string | null; startedAt?: string | null; updatedAt?: string | null; ocrUsed?: boolean | null }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const elapsedMs = startMs !== null && now !== null ? Math.max(0, now - startMs) : 0;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : null;
  const sinceUpdateMs = updatedMs !== null && now !== null ? Math.max(0, now - updatedMs) : null;
  const showLongNotice = elapsedMs >= LONG_PROCESSING_THRESHOLD_MS;
  const showStaleNotice = elapsedMs >= STALE_PROCESSING_THRESHOLD_MS;

  // Current step index; default to the first step until the server reports one.
  const currentStage = normalizeAccountingProcessingStage(step);
  const currentIndex = ACCOUNTING_PROCESSING_STAGE_ORDER.indexOf(currentStage);
  const currentLabel = ACCOUNTING_PROCESSING_STAGE_LABELS[currentStage];

  return (
    <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/60 p-3" role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-wide text-blue-700">
          Processing your statement
        </p>
        {startMs !== null ? (
          <span className="font-mono text-xs font-semibold text-blue-700" aria-label="Elapsed time">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
      </div>
      {sinceUpdateMs !== null ? (
        <p className="mt-1 text-[11px] font-semibold text-blue-700">Last update {formatElapsed(sinceUpdateMs)} ago</p>
      ) : null}

      <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {ACCOUNTING_PROCESSING_STAGE_ORDER.map((s, index) => {
          const label = ACCOUNTING_PROCESSING_STAGE_LABELS[s];
          const done = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li
              key={s}
              className={`flex items-center gap-1 text-[11px] font-semibold ${
                active ? "text-blue-700" : done ? "text-emerald-600" : "text-slate-400"
              }`}
            >
              <span aria-hidden>{done ? "✓" : active ? "●" : "○"}</span>
              {label}
            </li>
          );
        })}
      </ol>

      <p className="mt-2 text-[11px] font-semibold text-blue-800">Current activity: {currentLabel}</p>
      {currentStage === "extracting" && ocrUsed !== null && ocrUsed !== undefined ? (
        <p className="mt-1 text-[11px] font-medium text-slate-600">
          {ocrUsed ? "OCR processing is being used." : "Using the document’s native text layer; OCR was not needed."}
        </p>
      ) : null}

      {showStaleNotice ? (
        <p className="mt-2 text-[11px] font-semibold text-amber-700">{STALE_PROCESSING_NOTICE}</p>
      ) : showLongNotice ? (
        <p className="mt-2 text-[11px] font-semibold text-blue-700">{LONG_PROCESSING_NOTICE}</p>
      ) : null}
    </div>
  );
}

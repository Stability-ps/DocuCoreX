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

// "8 sec ago" reads as liveness; "0:08 ago" reads as a duration and invites
// comparison with the elapsed clock beside it. They measure different things.
function formatSince(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec ago`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
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
  // Elapsed runtime and liveness answer different questions, and only one of
  // them is evidence of a problem. A 15-minute classification run with a
  // 10-second-old heartbeat is healthy; a 3-minute run whose heartbeat stopped
  // 11 minutes ago is not. This notice previously fired on elapsed runtime
  // while its wording claimed the heartbeat had stopped, so every genuinely
  // long run was told it might be stuck.
  //
  // With no heartbeat to read, nothing is claimed: silence is better than
  // asserting staleness from the only clock that cannot show it. The server
  // owns real stale detection (markRunStuckIfNeeded) and is not affected.
  const showLongNotice = elapsedMs >= LONG_PROCESSING_THRESHOLD_MS;
  const showStaleNotice = sinceUpdateMs !== null && sinceUpdateMs >= STALE_PROCESSING_THRESHOLD_MS;

  // Current step index; default to the first step until the server reports one.
  const currentStage = normalizeAccountingProcessingStage(step);
  const currentIndex = ACCOUNTING_PROCESSING_STAGE_ORDER.indexOf(currentStage);
  const currentLabel = ACCOUNTING_PROCESSING_STAGE_LABELS[currentStage];
  const headerLabel = currentStage === "generatingWorkbook" ? "Finalising your statement" : "Processing your statement";
  const activeSegmentClass = showStaleNotice ? "bg-slate-400" : "bg-royal-600 animate-pulse motion-reduce:animate-none";

  return (
    <div className="mt-2 rounded-xl border border-blue-100 bg-white/70 p-3 shadow-sm" role="status" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-blue-700">{headerLabel}</p>
          <p className="mt-1 text-[11px] font-semibold text-blue-800">Current activity: {currentLabel}</p>
        </div>
        {startMs !== null ? (
          <span className="font-mono text-xs font-semibold text-blue-700" aria-label="Elapsed time">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
      </div>
      {sinceUpdateMs !== null ? (
        <p className="mt-1 text-[11px] font-semibold text-blue-700">Last update {formatSince(sinceUpdateMs)}</p>
      ) : null}

      <div className="mt-3" role="progressbar" aria-label={`Processing stages: ${currentLabel}`} aria-valuetext={`Current stage: ${currentLabel}`}>
        <div className="flex gap-1">
          {ACCOUNTING_PROCESSING_STAGE_ORDER.map((stage, index) => {
            const done = index < currentIndex;
            const active = index === currentIndex;
            return (
              <div
                key={stage}
                className={`h-2 flex-1 rounded-full transition-colors ${
                  done ? "bg-royal-600" : active ? activeSegmentClass : "bg-slate-200"
                }`}
              />
            );
          })}
        </div>
      </div>

      <ul className="mt-3 grid gap-x-3 gap-y-1 sm:grid-cols-3">
        {ACCOUNTING_PROCESSING_STAGE_ORDER.map((stage, index) => {
          const label = ACCOUNTING_PROCESSING_STAGE_LABELS[stage];
          const done = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li
              key={stage}
              className={`flex items-center gap-1 text-[11px] font-semibold ${
                active ? "text-blue-700" : done ? "text-emerald-600" : "text-slate-400"
              }`}
            >
              <span aria-hidden>{done ? "✓" : active ? "●" : "○"}</span>
              {label}
            </li>
          );
        })}
      </ul>

      {currentStage === "extracting" && ocrUsed !== null && ocrUsed !== undefined ? (
        <p className="mt-3 text-[11px] font-medium text-slate-600">
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

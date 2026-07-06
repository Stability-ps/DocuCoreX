"use client";

import { useEffect, useState } from "react";
import {
  LONG_PROCESSING_NOTICE,
  LONG_PROCESSING_THRESHOLD_MS,
  PROCESSING_STEP_LABELS,
  PROCESSING_STEP_ORDER,
  STALE_PROCESSING_NOTICE,
  STALE_PROCESSING_THRESHOLD_MS,
} from "@/lib/pdf/processingSteps";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Live processing stepper shown while a statement is being processed: the four
// steps ("Detecting PDF type" → "Running OCR" → "Parsing transactions" →
// "Reconciling"), an elapsed timer, and a reassurance once it runs long
// (scanned PDFs legitimately take longer).
export function ProcessingSteps({ step, startedAt }: { step?: string | null; startedAt?: string | null }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  const elapsedMs = startMs !== null && now !== null ? Math.max(0, now - startMs) : 0;
  const showLongNotice = elapsedMs >= LONG_PROCESSING_THRESHOLD_MS;
  const showStaleNotice = elapsedMs >= STALE_PROCESSING_THRESHOLD_MS;

  // Current step index; default to the first step until the server reports one.
  const currentIndex = Math.max(
    0,
    PROCESSING_STEP_ORDER.findIndex((s) => PROCESSING_STEP_LABELS[s] === step),
  );

  return (
    <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/60 p-3" role="status" aria-live="polite">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-wide text-blue-700">
          {step ?? PROCESSING_STEP_LABELS.detecting}
        </p>
        {startMs !== null ? (
          <span className="font-mono text-xs font-semibold text-blue-700" aria-label="Elapsed time">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
      </div>

      <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {PROCESSING_STEP_ORDER.map((s, index) => {
          const label = PROCESSING_STEP_LABELS[s];
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

      {showStaleNotice ? (
        <p className="mt-2 text-[11px] font-semibold text-amber-700">{STALE_PROCESSING_NOTICE}</p>
      ) : showLongNotice ? (
        <p className="mt-2 text-[11px] font-semibold text-blue-700">{LONG_PROCESSING_NOTICE}</p>
      ) : null}
    </div>
  );
}

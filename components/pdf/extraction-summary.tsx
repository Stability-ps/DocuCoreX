"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ScanLine } from "lucide-react";

type PipelineSummary = {
  analysis: { kind: string; needsOcr: boolean; averageTextPerPage: number; isDigitalPdf: boolean; confidence: number };
  ocrUsed: boolean;
  parserMethod: string;
  routeReason: string;
  selection: { selectedParser: string; confidence: number; reasons: string[]; warnings: string[]; requiresReview: boolean };
  validation: null | {
    valid: boolean;
    requiresReview: boolean;
    expectedClosingBalance: number | null;
    calculatedClosingBalance: number | null;
    difference: number | null;
    missingTransactionCount: number | null;
    checks: Array<{ rule: string; ok: boolean; detail: string }>;
  };
  warnings: string[];
  requiresReview: boolean;
  transactionCount: number;
};

const money = (v: number | null | undefined) =>
  v == null ? "—" : `R${v.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Shows the multi-parser extraction outcome for a processed document: selected
// parser, confidence, whether OCR was used, validation status and warnings.
export function ExtractionSummary({ documentId }: { documentId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [data, setData] = useState<PipelineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("loading");
    setError(null);
    try {
      const response = await fetch(`/api/pdf/analyze/${documentId}`);
      const body = (await response.json().catch(() => ({}))) as PipelineSummary & { error?: string };
      if (!response.ok) throw new Error(body.error || "Extraction analysis failed.");
      setData(body);
      setState("ready");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Extraction analysis failed.");
      setState("error");
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScanLine className="h-4 w-4 text-royal-600" />
          <h3 className="text-sm font-black text-navy-950">Extraction analysis</h3>
        </div>
        {state !== "loading" ? (
          <button onClick={() => void run()} className="rounded-lg bg-royal-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-royal-700">
            {state === "idle" ? "Run analysis" : "Re-run"}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Analysing…
          </span>
        )}
      </div>

      {state === "idle" ? (
        <p className="mt-2 text-xs font-semibold text-slate-500">Compare PDF.js, pdfplumber and OCR extraction and validate against the statement figures.</p>
      ) : null}

      {state === "error" ? <p className="mt-2 text-xs font-bold text-rose-700">{error}</p> : null}

      {state === "ready" && data ? (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Parser method" value={data.parserMethod} />
            <Metric label="Confidence" value={`${data.selection.confidence}%`} warn={data.selection.confidence < 60} />
            <Metric label="OCR used" value={data.ocrUsed ? "Yes" : "No"} />
            <Metric label="Detected type" value={data.analysis.kind} warn={data.analysis.needsOcr} />
          </div>
          {data.routeReason ? <p className="text-xs font-semibold text-slate-500">{data.routeReason}</p> : null}

          <div className={`flex items-center gap-2 rounded-lg border p-2 text-xs font-bold ${data.requiresReview ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-100 bg-emerald-50 text-emerald-800"}`}>
            {data.requiresReview ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {data.requiresReview ? "Extraction completed but reconciliation needs review." : "Extraction validated — reconciles."}
          </div>

          {data.validation && data.validation.difference != null && data.validation.difference !== 0 ? (
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <Cell label="Expected closing" value={money(data.validation.expectedClosingBalance)} />
              <Cell label="Calculated closing" value={money(data.validation.calculatedClosingBalance)} />
              <Cell label="Difference" value={money(data.validation.difference)} warn />
            </dl>
          ) : null}
          {data.validation?.missingTransactionCount ? (
            <p className="text-xs font-bold text-amber-700">Suspected {data.validation.missingTransactionCount} missing transaction(s) ({data.transactionCount} extracted).</p>
          ) : null}

          {data.warnings.length ? (
            <ul className="space-y-0.5 text-xs font-semibold text-slate-600">
              {data.warnings.map((warning, index) => (
                <li key={index}>• {warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-center">
      <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm font-black capitalize ${warn ? "text-amber-800" : "text-navy-950"}`}>{value}</p>
    </div>
  );
}

function Cell({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-100 p-2">
      <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm font-bold ${warn ? "text-amber-800" : "text-navy-950"}`}>{value}</p>
    </div>
  );
}

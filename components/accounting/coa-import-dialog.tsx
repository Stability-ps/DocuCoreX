"use client";

/**
 * Chart of accounts import.
 *
 * Upload is never the same request as commit — this dialog always shows a
 * preview and waits for an explicit "Import" click, even for a file with
 * zero errors. Every row that isn't new or updated (an error, or a row that
 * exactly matches what's already there) is excluded from the count the
 * Import button acts on, so that button only ever writes rows already shown
 * as safe to write.
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, Upload, X } from "lucide-react";
import { toCsv } from "@/lib/accounting/ledger";
import type { CoaImportOutcome } from "@/lib/accounting/coa-import";

type PreviewResponse = {
  outcomes: CoaImportOutcome[];
  summary: { total: number; newCount: number; updatedCount: number; unchangedCount: number; errorCount: number };
};

function downloadErrorReport(filename: string, outcomes: CoaImportOutcome[]) {
  const errors = outcomes.filter((o): o is Extract<CoaImportOutcome, { status: "error" }> => o.status === "error");
  const csv = toCsv(
    ["row", "code", "message"],
    errors.map((e) => [e.rowNumber, e.code ?? "", e.message]),
  );
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function CoaImportDialog({ companyId, onCancel, onDone }: { companyId: string; onCancel: () => void; onDone: () => void }) {
  const [filename, setFilename] = useState("");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ createdCount: number; updatedCount: number; failedCount: number } | null>(null);

  const onFile = async (file: File) => {
    setError("");
    setPreview(null);
    setResult(null);
    setFilename(file.name);
    const text = await file.text();
    setCsvText(text);
    setLoading(true);
    try {
      const response = await fetch("/api/accounting/coa-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", companyId, csvText: text }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to read the file.");
      setPreview(data);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Unable to read the file.");
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    setCommitting(true);
    setError("");
    try {
      const response = await fetch("/api/accounting/coa-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "commit", companyId, filename, csvText }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Unable to import the file.");
      setResult(data);
      onDone();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "Unable to import the file.");
    } finally {
      setCommitting(false);
    }
  };

  const writableCount = preview ? preview.summary.newCount + preview.summary.updatedCount : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-navy-950">Import chart of accounts</h3>
          <button type="button" onClick={onCancel} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {error ? <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}

        {result ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {result.createdCount} created, {result.updatedCount} updated
              {result.failedCount ? `, ${result.failedCount} failed at write time` : ""}.
            </p>
            <button type="button" onClick={onCancel} className="rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white hover:bg-navy-900">
              Done
            </button>
          </div>
        ) : (
          <>
            {!preview ? (
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-royal-400 hover:bg-slate-50">
                <Upload className="h-8 w-8 text-slate-400" aria-hidden="true" />
                <span className="text-sm font-semibold text-navy-950">
                  {loading ? "Reading…" : "Click to choose a CSV file"}
                </span>
                <span className="text-xs text-slate-500">code, name, account_type, normal_balance, parent_code, vat_default, description</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  disabled={loading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onFile(file);
                  }}
                />
              </label>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    { label: "New", value: preview.summary.newCount, tone: "text-emerald-700" },
                    { label: "Updated", value: preview.summary.updatedCount, tone: "text-royal-700" },
                    { label: "Unchanged", value: preview.summary.unchangedCount, tone: "text-slate-500" },
                    { label: "Errors", value: preview.summary.errorCount, tone: "text-red-700" },
                  ].map((stat) => (
                    <div key={stat.label} className="rounded-lg border border-slate-200 px-3 py-2 text-center">
                      <p className={`text-lg font-bold tabular-nums ${stat.tone}`}>{stat.value}</p>
                      <p className="text-xs font-semibold text-slate-500">{stat.label}</p>
                    </div>
                  ))}
                </div>

                {preview.summary.errorCount ? (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-red-200 bg-red-50">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-red-200">
                          <th className="px-3 py-1.5 font-bold text-red-800">Row</th>
                          <th className="px-3 py-1.5 font-bold text-red-800">Code</th>
                          <th className="px-3 py-1.5 font-bold text-red-800">Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.outcomes
                          .filter((o): o is Extract<CoaImportOutcome, { status: "error" }> => o.status === "error")
                          .map((o) => (
                            <tr key={o.rowNumber} className="border-b border-red-100 last:border-0">
                              <td className="px-3 py-1.5 text-red-700">{o.rowNumber}</td>
                              <td className="px-3 py-1.5 font-semibold text-red-900">{o.code ?? "—"}</td>
                              <td className="px-3 py-1.5 text-red-700">{o.message}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!writableCount || committing}
                    onClick={() => void commit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                    Import {writableCount} valid row{writableCount === 1 ? "" : "s"}
                  </button>
                  {preview.summary.errorCount ? (
                    <button
                      type="button"
                      onClick={() => downloadErrorReport(`${filename.replace(/\.csv$/i, "")}-errors.csv`, preview.outcomes)}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Download error report
                    </button>
                  ) : null}
                  <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
                    Cancel
                  </button>
                </div>

                {!writableCount ? (
                  <p className="flex items-center gap-2 text-xs font-semibold text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Nothing to import — every row is either unchanged or has an error.
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

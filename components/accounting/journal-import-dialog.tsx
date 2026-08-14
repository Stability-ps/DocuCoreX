"use client";

/**
 * Bulk journal import.
 *
 * Preview groups rows by reference and shows counts at the JOURNAL level,
 * not the row level — "193 valid, 7 rejected" means 193 whole journals, each
 * of which may be one row or fifty. A rejected group's every row failed
 * together, because one bad line in a journal makes the whole journal
 * unpostable, not just that line.
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, Upload, X } from "lucide-react";
import { toCsv } from "@/lib/accounting/ledger";
import type { JournalImportOutcome } from "@/lib/accounting/journal-import";

type PreviewResponse = {
  outcomes: JournalImportOutcome[];
  summary: { totalGroups: number; validGroups: number; rejectedGroups: number };
};

function downloadErrorReport(filename: string, outcomes: JournalImportOutcome[]) {
  const errors = outcomes.filter((o): o is Extract<JournalImportOutcome, { status: "error" }> => o.status === "error");
  const csv = toCsv(
    ["reference", "rows", "problems"],
    errors.map((e) => [e.reference || "(missing)", e.rowNumbers.join("; "), e.messages.join(" | ")]),
  );
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function JournalImportDialog({ companyId, onCancel, onDone }: { companyId: string; onCancel: () => void; onDone: () => void }) {
  const [filename, setFilename] = useState("");
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ postedCount: number; failedCount: number } | null>(null);

  const onFile = async (file: File) => {
    setError("");
    setPreview(null);
    setResult(null);
    setFilename(file.name);
    const text = await file.text();
    setCsvText(text);
    setLoading(true);
    try {
      const response = await fetch("/api/accounting/journal-import", {
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
      const response = await fetch("/api/accounting/journal-import", {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-navy-950">Import journals</h3>
          <button type="button" onClick={onCancel} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {error ? <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p> : null}

        {result ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {result.postedCount} journal{result.postedCount === 1 ? "" : "s"} posted
              {result.failedCount ? `, ${result.failedCount} failed at post time` : ""}.
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
                <span className="text-sm font-semibold text-navy-950">{loading ? "Reading…" : "Click to choose a CSV file"}</span>
                <span className="text-xs text-slate-500">
                  reference, journal_date, description, due_date, journal_type, account_code, debit, credit, tax_code, customer, supplier
                </span>
                <span className="text-xs text-slate-400">One row per line; rows sharing a reference form one journal.</span>
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
                <p className="text-sm font-semibold text-navy-950">{preview.summary.totalGroups} journals detected</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold tabular-nums text-emerald-700">{preview.summary.validGroups}</p>
                    <p className="text-xs font-semibold text-emerald-800">Valid</p>
                  </div>
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center">
                    <p className="text-lg font-bold tabular-nums text-red-700">{preview.summary.rejectedGroups}</p>
                    <p className="text-xs font-semibold text-red-800">Rejected</p>
                  </div>
                </div>

                {preview.summary.rejectedGroups ? (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-red-200 bg-red-50">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-red-200">
                          <th className="px-3 py-1.5 font-bold text-red-800">Reference</th>
                          <th className="px-3 py-1.5 font-bold text-red-800">Rows</th>
                          <th className="px-3 py-1.5 font-bold text-red-800">Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.outcomes
                          .filter((o): o is Extract<JournalImportOutcome, { status: "error" }> => o.status === "error")
                          .map((o, index) => (
                            <tr key={`${o.reference}-${index}`} className="border-b border-red-100 last:border-0">
                              <td className="px-3 py-1.5 font-semibold text-red-900">{o.reference || "(missing)"}</td>
                              <td className="px-3 py-1.5 text-red-700">{o.rowNumbers.join(", ")}</td>
                              <td className="px-3 py-1.5 text-red-700">{o.messages.join(" ")}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!preview.summary.validGroups || committing}
                    onClick={() => void commit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-navy-950 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                    Import {preview.summary.validGroups} Valid Journal{preview.summary.validGroups === 1 ? "" : "s"}
                  </button>
                  {preview.summary.rejectedGroups ? (
                    <button
                      type="button"
                      onClick={() => downloadErrorReport(`${filename.replace(/\.csv$/i, "")}-errors.csv`, preview.outcomes)}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Download Error Report
                    </button>
                  ) : null}
                  <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-navy-950 hover:bg-slate-50">
                    Cancel
                  </button>
                </div>

                {!preview.summary.validGroups ? (
                  <p className="flex items-center gap-2 text-xs font-semibold text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Nothing to import — every journal in this file was rejected.
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

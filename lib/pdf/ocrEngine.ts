// SERVER-ONLY. The single OCRmyPDF/Tesseract implementation, shared by:
//   • app/api/ocr-text/route.ts   — the HTTP endpoint Vercel calls
//   • lib/pdf/extractWithOcr.ts   — the in-process path used in worker mode
//
// It requires native binaries (ocrmypdf, tesseract, ghostscript) and node:
// child_process/fs, so it must never be imported from client code or from a
// runtime that lacks those tools. `extractWithOcr` imports it dynamically so it
// is only loaded on the conversion worker.
//
// Extracted verbatim from the route so there is exactly ONE implementation of the
// flag escalation, time budgets, TSV confidence and failure classification.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateTsvConfidence, heuristicConfidence } from "@/lib/pdf/ocrConfidence";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Per-attempt cap and total budget are configurable so production can raise OCR
// time limits for high-resolution scanned bank statements without code changes.
// 120s default matches the caller's timeout — OCR never runs longer than the
// caller waits (which would only produce a wasted result). Read at call time so
// the value is never baked in at module load.
function timeouts() {
  const perAttempt = readTimeoutMs(process.env.CONVERSION_OCR_TIMEOUT_MS ?? process.env.ACCOUNTING_OCR_TIMEOUT_MS, 120_000);
  const total = readTimeoutMs(process.env.CONVERSION_OCR_TOTAL_BUDGET_MS ?? process.env.ACCOUNTING_OCR_TOTAL_BUDGET_MS, perAttempt);
  return { perAttempt, total };
}

export function bin(envKey: string, fallback: string): string {
  return (process.env[envKey] && process.env[envKey]!.trim()) || fallback;
}

export function which(binary: string): string | null {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** OCR binary health check — backs the endpoint's GET handler. */
export function ocrBinaryHealth() {
  const langs = spawnSync(bin("TESSERACT_PATH", "tesseract"), ["--list-langs"], { encoding: "utf8" });
  return {
    ocrmypdf: which(bin("OCRMYPDF_PATH", "ocrmypdf")),
    tesseract: which(bin("TESSERACT_PATH", "tesseract")),
    ghostscript: which("gs"),
    tesseractLangs: (langs.stdout || langs.stderr || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    workerMode: process.env.CONVERSION_WORKER_MODE === "true",
  };
}

export type OcrAttempt = { flags: string[]; exitCode: number | null; stderrSample: string; textLength: number };

/** The success/timeout payload — this IS the HTTP response body shape. */
export type OcrTextPayload = {
  text: string;
  pages: number;
  confidence: number;
  confidenceSource: string;
  lowConfidenceWordRatio: number | null;
  warnings: string[];
  reason: string | null;
  ocrDebug: Record<string, unknown>;
};

export type OcrErrorPayload = { error: string; ocrDebug: Record<string, unknown> };

/** Status + body, so the HTTP route is a one-line mapping and the in-process
 *  caller sees exactly what an HTTP caller would have seen. */
export type OcrRunResult =
  | { status: 200; body: OcrTextPayload }
  | { status: 504; body: OcrTextPayload }
  | { status: 501 | 500; body: OcrErrorPayload };

// Run a Tesseract TSV pass over the OCR'd PDF to obtain per-word confidences.
// The searchable PDF produced by ocrmypdf is rasterised by Tesseract itself, so
// this reads the same glyphs ocrmypdf recognised. Best-effort: any failure falls
// back to the character-density heuristic, which is clearly labelled as such.
function tesseractConfidence(pdfPath: string, tempDir: string, timeoutMs: number) {
  try {
    const tesseract = bin("TESSERACT_PATH", "tesseract");
    if (!which(tesseract)) return null;
    const result = spawnSync(tesseract, [pdfPath, "stdout", "-l", "eng", "tsv"], {
      cwd: tempDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) return null;
    return aggregateTsvConfidence(result.stdout);
  } catch {
    return null;
  }
}

/**
 * OCR a PDF with OCRmyPDF, escalating flag sets only on a clear content failure.
 * Time-bounded and fully instrumented — it never returns an empty result without
 * the exact reason.
 *
 * @param endpoint label recorded in `ocrDebug.ocr_endpoint`: the request path for
 *        an HTTP call, or "in-process" when the worker pipeline calls directly.
 */
export function runOcrText(fileBytes: Uint8Array, fileName = "document.pdf", endpoint = "in-process"): OcrRunResult {
  const { perAttempt: OCR_TIMEOUT_MS, total: OCR_TOTAL_BUDGET_MS } = timeouts();
  console.info("[ocr-text] request received", { endpoint, fileName, fileSize: fileBytes.byteLength });

  const ocrmypdf = bin("OCRMYPDF_PATH", "ocrmypdf");
  if (!which(ocrmypdf)) {
    console.error("[ocr-text] ocrmypdf not found", { endpoint });
    return {
      status: 501,
      body: { error: "OCR engine (ocrmypdf) is not installed on this worker.", ocrDebug: { ocr_endpoint: endpoint, ocr_status: 501, ocrmypdf: null } },
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-ocrtext-"));
  const inputPath = join(tempDir, "input.pdf");
  const outputPath = join(tempDir, "output.pdf");
  const sidecarPath = join(tempDir, "sidecar.txt");

  try {
    writeFileSync(inputPath, fileBytes);
    console.info("[ocr-text] wrote temp input", { inputPath, bytes: fileBytes.byteLength });

    // Cost-minimised OCR: run ONE plain single-threaded pass first —
    //   ocrmypdf -l eng --jobs 1 --sidecar sidecar.txt input.pdf output.pdf
    // (--jobs 1 caps memory so Ghostscript/Tesseract cannot OOM the instance and
    // trigger a raw 502). Only escalate to the heavier recovery modes when the
    // previous attempt failed CLEARLY with no text — never after a timeout.
    const flagSets: string[][] = [
      ["-l", "eng", "--jobs", "1", "--sidecar", sidecarPath, "--output-type", "pdf", inputPath, outputPath],
      ["-l", "eng", "--jobs", "1", "--skip-text", "--sidecar", sidecarPath, "--output-type", "pdf", inputPath, outputPath],
      ["-l", "eng", "--jobs", "1", "--force-ocr", "--sidecar", sidecarPath, "--output-type", "pdf", inputPath, outputPath],
      ["-l", "eng", "--jobs", "1", "--redo-ocr", "--sidecar", sidecarPath, "--output-type", "pdf", inputPath, outputPath],
    ];

    const attempts: OcrAttempt[] = [];
    const ocrStarted = Date.now();
    let text = "";
    let lastExit: number | null = null;
    let lastStderr = "";
    let timedOut = false;
    for (const flags of flagSets) {
      // Do not start another fallback mode once the total OCR budget is spent.
      if (attempts.length > 0 && Date.now() - ocrStarted >= OCR_TOTAL_BUDGET_MS) {
        console.warn("[ocr-text] total OCR budget exhausted — not escalating further", { elapsedMs: Date.now() - ocrStarted, attempts: attempts.length });
        break;
      }
      rmSync(sidecarPath, { force: true });
      const perAttemptTimeout = Math.max(1, Math.min(OCR_TIMEOUT_MS, OCR_TOTAL_BUDGET_MS - (Date.now() - ocrStarted)));
      const flagStr = flags.filter((f) => !f.startsWith("/")).join(" ");
      console.info("[ocr-text] OCR command started", { flags: flagStr, perAttemptTimeoutMs: perAttemptTimeout, attempt: attempts.length + 1 });
      const attemptStarted = Date.now();
      const result = spawnSync(ocrmypdf, flags, { cwd: tempDir, encoding: "utf8", timeout: perAttemptTimeout, maxBuffer: 64 * 1024 * 1024 });
      lastExit = result.status;
      lastStderr = (result.stderr || result.error?.message || "").toString();
      // spawnSync kills a timed-out child with SIGTERM and sets error.code ETIMEDOUT.
      const attemptTimedOut = result.signal === "SIGTERM" || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      const sidecarText = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : "";
      const sidecarSizeNow = existsSync(sidecarPath) ? statSync(sidecarPath).size : 0;
      attempts.push({ flags: flags.filter((f) => !f.startsWith("/")), exitCode: result.status, stderrSample: lastStderr.slice(0, 2000), textLength: sidecarText.trim().length });
      console.info("[ocr-text] OCR command finished", {
        flags: flagStr,
        exitCode: result.status,
        signal: result.signal ?? null,
        timedOut: attemptTimedOut,
        durationMs: Date.now() - attemptStarted,
        stderrSample: lastStderr.slice(0, 2000),
        sidecarExists: existsSync(sidecarPath),
        sidecarSize: sidecarSizeNow,
        textLength: sidecarText.trim().length,
      });
      if (sidecarText.trim().length > 0) {
        text = sidecarText;
        break;
      }
      // A timeout is not a "clear content failure" — heavier modes are only slower,
      // so stop and return a controlled 504 rather than risk OOM/raw 502.
      if (attemptTimedOut) {
        timedOut = true;
        break;
      }
    }

    // Controlled timeout result — always structured, never a crash / raw 502.
    if (timedOut && text.trim().length === 0) {
      const ocrDebug = {
        ocr_endpoint: endpoint,
        ocr_status: 504,
        ocr_exit_code: lastExit,
        ocr_stderr_sample: lastStderr.slice(0, 2000),
        sidecar_exists: existsSync(sidecarPath),
        sidecar_size: existsSync(sidecarPath) ? statSync(sidecarPath).size : 0,
        ocr_text_length: 0,
        attempts,
      };
      console.warn("[ocr-text] OCR timed out — returning controlled 504", { fileName, elapsedMs: Date.now() - ocrStarted, ocrDebug });
      return {
        status: 504,
        body: {
          text: "",
          pages: 0,
          confidence: 0,
          confidenceSource: "none",
          lowConfidenceWordRatio: null,
          warnings: ["OCR timed out before completing."],
          reason: "OCR timed out — the PDF is too large or complex to OCR within the time budget.",
          ocrDebug,
        },
      };
    }

    const sidecarExists = existsSync(sidecarPath);
    const sidecarSize = sidecarExists ? statSync(sidecarPath).size : 0;
    const trimmed = text.trim();
    const pages = trimmed ? text.split("\f").filter((p) => p.trim().length > 0).length || 1 : 0;

    // Real recognition confidence from Tesseract's per-word TSV output. The old
    // character-density heuristic remains the labelled fallback so a worker that
    // cannot run the TSV pass still reports something usable.
    const tsv = trimmed.length === 0 ? null : tesseractConfidence(existsSync(outputPath) ? outputPath : inputPath, tempDir, Math.max(1, OCR_TOTAL_BUDGET_MS - (Date.now() - ocrStarted)));
    const confidence = tsv ? tsv.confidence : heuristicConfidence(trimmed.length, pages);
    const confidenceSource = tsv ? "tesseract-tsv" : "heuristic";
    const lowConfidenceWordRatio = tsv ? tsv.lowConfidenceWordRatio : null;

    // Exact reason when nothing was recognised — encrypted / malformed /
    // image-only / Ghostscript permission failures come through in stderr.
    let reason: string | null = null;
    if (trimmed.length === 0) {
      const lower = lastStderr.toLowerCase();
      if (/encrypt|password/.test(lower)) reason = "PDF is encrypted / password-protected — cannot OCR.";
      else if (/not a pdf|inputfile|malformed|syntax error|could not (open|read)/.test(lower)) reason = "PDF is malformed or unreadable — cannot OCR.";
      else if (/ghostscript|gs\b|permission/.test(lower)) reason = "Ghostscript failed (permissions or rendering) during OCR.";
      else if (/priorocr|already.*text/.test(lower)) reason = "PDF already contains a text layer but no readable text was extracted.";
      else reason = "OCR completed but no readable text was found.";
    }

    const ocrDebug = {
      ocr_endpoint: endpoint,
      ocr_status: lastExit === 0 ? 200 : 422,
      ocr_exit_code: lastExit,
      ocr_stderr_sample: lastStderr.slice(0, 2000),
      sidecar_exists: sidecarExists,
      sidecar_size: sidecarSize,
      ocr_text_length: trimmed.length,
      ocr_confidence: confidence,
      ocr_confidence_source: confidenceSource,
      ocr_low_confidence_word_ratio: lowConfidenceWordRatio,
      ocr_confidence_words: tsv?.words ?? 0,
      attempts,
    };

    // Content-free: lengths and status only. The OCR'd document text is never logged.
    console.info("[ocr-text] result", { fileName, ...ocrDebug });

    return {
      status: 200,
      body: { text, pages, confidence, confidenceSource, lowConfidenceWordRatio, warnings: reason ? [reason] : [], reason, ocrDebug },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ocr-text] failed", { endpoint, error: message });
    return { status: 500, body: { error: `OCR failed: ${message}`, ocrDebug: { ocr_endpoint: endpoint } } };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

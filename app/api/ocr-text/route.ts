import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// OCR text-extraction endpoint for the multi-parser pipeline. Runs on the
// conversion worker (ships ocrmypdf / tesseract / ghostscript) and returns
// { text, pages, confidence, warnings, ocrDebug } for a PDF. Time-bounded and
// fully instrumented — it never returns an empty result without the exact reason.
//
// Manual test:
//   curl -F "file=@sample.pdf" \
//     -H "x-docucorex-worker-secret: $CONVERSION_WORKER_SECRET" \
//     https://<conversion-worker-url>/api/ocr-text
//   GET the same URL to check the OCR binaries.
// Per-attempt cap and total budget are configurable so production can raise OCR
// time limits for high-resolution scanned bank statements without code changes.
const OCR_TIMEOUT_MS = readTimeoutMs(process.env.CONVERSION_OCR_TIMEOUT_MS ?? process.env.ACCOUNTING_OCR_TIMEOUT_MS, 300_000);
const OCR_TOTAL_BUDGET_MS = readTimeoutMs(process.env.CONVERSION_OCR_TOTAL_BUDGET_MS ?? process.env.ACCOUNTING_OCR_TOTAL_BUDGET_MS, OCR_TIMEOUT_MS);

function bin(envKey: string, fallback: string): string {
  return (process.env[envKey] && process.env[envKey]!.trim()) || fallback;
}

function which(binary: string): string | null {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function authorized(request: Request): boolean {
  if (process.env.CONVERSION_WORKER_MODE !== "true") return true;
  const configured = process.env.CONVERSION_WORKER_SECRET?.trim();
  if (!configured) return true;
  const provided = request.headers.get("x-docucorex-worker-secret")?.trim();
  return provided === configured;
}

// GET → OCR binary health check (task 3).
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized worker request" }, { status: 401 });
  const langs = spawnSync(bin("TESSERACT_PATH", "tesseract"), ["--list-langs"], { encoding: "utf8" });
  return NextResponse.json({
    ocrmypdf: which(bin("OCRMYPDF_PATH", "ocrmypdf")),
    tesseract: which(bin("TESSERACT_PATH", "tesseract")),
    ghostscript: which("gs"),
    tesseractLangs: (langs.stdout || langs.stderr || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    workerMode: process.env.CONVERSION_WORKER_MODE === "true",
  });
}

type OcrAttempt = { flags: string[]; exitCode: number | null; stderrSample: string; textLength: number };

export async function POST(request: Request) {
  const endpoint = new URL(request.url).pathname;
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized worker request" }, { status: 401 });

  const contentType = request.headers.get("content-type") || "";
  let fileBytes: Uint8Array;
  let fileName = "document.pdf";
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return NextResponse.json({ error: "No file provided.", ocrDebug: { ocr_endpoint: endpoint, content_type: contentType } }, { status: 400 });
    fileBytes = new Uint8Array(await file.arrayBuffer());
    if ("name" in file && typeof (file as File).name === "string") fileName = (file as File).name;
  } catch (error) {
    return NextResponse.json({ error: `Could not read upload: ${error instanceof Error ? error.message : String(error)}`, ocrDebug: { ocr_endpoint: endpoint, content_type: contentType } }, { status: 400 });
  }

  console.info("[ocr-text] request received", { endpoint, contentType, fileName, fileSize: fileBytes.byteLength });

  const ocrmypdf = bin("OCRMYPDF_PATH", "ocrmypdf");
  if (!which(ocrmypdf)) {
    console.error("[ocr-text] ocrmypdf not found");
    return NextResponse.json({ error: "OCR engine (ocrmypdf) is not installed on this worker.", ocrDebug: { ocr_endpoint: endpoint, ocr_status: 501, ocrmypdf: null } }, { status: 501 });
  }

  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-ocrtext-"));
  const inputPath = join(tempDir, "input.pdf");
  const outputPath = join(tempDir, "output.pdf");
  const sidecarPath = join(tempDir, "sidecar.txt");

  try {
    writeFileSync(inputPath, fileBytes);
    console.info("[ocr-text] wrote temp input", { inputPath, bytes: fileBytes.byteLength });

    // Cost-minimised OCR (Req 4/5/6): run ONE plain single-threaded pass first —
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
      // so stop and return a controlled 504 rather than risk OOM/raw 502 (Req 3/6).
      if (attemptTimedOut) {
        timedOut = true;
        break;
      }
    }

    // Controlled timeout response — always JSON, never a crash / raw 502 (Req 3/7).
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
      return NextResponse.json(
        { text: "", pages: 0, confidence: 0, warnings: ["OCR timed out before completing."], reason: "OCR timed out — the PDF is too large or complex to OCR within the time budget.", ocrDebug },
        { status: 504 },
      );
    }

    const sidecarExists = existsSync(sidecarPath);
    const sidecarSize = sidecarExists ? statSync(sidecarPath).size : 0;
    const trimmed = text.trim();
    const pages = trimmed ? text.split("\f").filter((p) => p.trim().length > 0).length || 1 : 0;
    const confidence = trimmed.length === 0 ? 0 : Math.max(10, Math.min(95, Math.round(trimmed.length / Math.max(1, pages) / 8)));

    // Exact reason when nothing was recognised (task 6) — encrypted / malformed /
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
      attempts,
    };

    console.info("[ocr-text] result", { fileName, ...ocrDebug, sample: trimmed.slice(0, 1000) });

    return NextResponse.json({
      text,
      pages,
      confidence,
      warnings: reason ? [reason] : [],
      reason,
      ocrDebug,
    });
  } catch (error) {
    console.error("[ocr-text] failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: `OCR failed: ${error instanceof Error ? error.message : String(error)}`, ocrDebug: { ocr_endpoint: endpoint } }, { status: 500 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

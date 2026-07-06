import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
const OCR_TIMEOUT_MS = 170_000;

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

    // Fallback chain — try force-ocr, then skip-text, then redo-ocr (task 5).
    const flagSets: string[][] = [
      ["-l", "eng", "--force-ocr", "--sidecar", sidecarPath, "--output-type", "pdf", "--jobs", "1", inputPath, outputPath],
      ["-l", "eng", "--skip-text", "--sidecar", sidecarPath, "--output-type", "pdf", "--jobs", "1", inputPath, outputPath],
      ["-l", "eng", "--redo-ocr", "--sidecar", sidecarPath, "--output-type", "pdf", "--jobs", "1", inputPath, outputPath],
    ];

    const attempts: OcrAttempt[] = [];
    let text = "";
    let lastExit: number | null = null;
    let lastStderr = "";
    for (const flags of flagSets) {
      rmSync(sidecarPath, { force: true });
      const result = spawnSync(ocrmypdf, flags, { cwd: tempDir, encoding: "utf8", timeout: OCR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      lastExit = result.status;
      lastStderr = (result.stderr || result.error?.message || "").toString();
      const sidecarText = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : "";
      attempts.push({ flags: flags.filter((f) => !f.startsWith("/")), exitCode: result.status, stderrSample: lastStderr.slice(0, 2000), textLength: sidecarText.trim().length });
      console.info("[ocr-text] ocrmypdf attempt", {
        flags: flags.filter((f) => !f.startsWith("/")).join(" "),
        exitCode: result.status,
        stderrSample: lastStderr.slice(0, 2000),
        sidecarExists: existsSync(sidecarPath),
        sidecarSize: existsSync(sidecarPath) ? statSync(sidecarPath).size : 0,
        textLength: sidecarText.trim().length,
      });
      if (sidecarText.trim().length > 0) {
        text = sidecarText;
        break;
      }
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

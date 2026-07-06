import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OCR text-extraction endpoint for the multi-parser pipeline. Runs on the
// conversion worker (which ships ocrmypdf / tesseract / ghostscript) and returns
// { text, pages, confidence, warnings } for a PDF. Defensive and time-bounded so
// processing never hangs.
const OCR_TIMEOUT_MS = 170_000;

function ocrmypdfBinary(): string {
  return (process.env.OCRMYPDF_PATH && process.env.OCRMYPDF_PATH.trim()) || "ocrmypdf";
}

export async function POST(request: Request) {
  // Worker-mode shared-secret auth (matches the other worker routes).
  if (process.env.CONVERSION_WORKER_MODE === "true") {
    const configured = process.env.CONVERSION_WORKER_SECRET?.trim();
    const provided = request.headers.get("x-docucorex-worker-secret")?.trim();
    if (configured && provided !== configured) {
      return NextResponse.json({ error: "Unauthorized worker request" }, { status: 401 });
    }
  }

  let fileBytes: Uint8Array;
  let fileName = "document.pdf";
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    fileBytes = new Uint8Array(await file.arrayBuffer());
    if ("name" in file && typeof (file as File).name === "string") fileName = (file as File).name;
  } catch (error) {
    return NextResponse.json({ error: `Could not read upload: ${error instanceof Error ? error.message : String(error)}` }, { status: 400 });
  }

  console.info("[ocr-text] request", { fileName, fileSize: fileBytes.byteLength });

  const tempDir = mkdtempSync(join(tmpdir(), "docucorex-ocrtext-"));
  const inputPath = join(tempDir, "input.pdf");
  const outputPath = join(tempDir, "output.pdf");
  const sidecarPath = join(tempDir, "sidecar.txt");

  try {
    writeFileSync(inputPath, fileBytes);
    // --force-ocr rasterises and OCRs every page (reliable for scanned/weak PDFs);
    // --sidecar writes the recognised text to a plain-text file.
    const result = spawnSync(
      ocrmypdfBinary(),
      ["--force-ocr", "--language", "eng", "--sidecar", sidecarPath, "--output-type", "pdf", "--jobs", "1", inputPath, outputPath],
      { cwd: tempDir, encoding: "utf8", timeout: OCR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );

    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("[ocr-text] ocrmypdf not found");
      return NextResponse.json({ error: "OCR engine (ocrmypdf) is not installed on this worker." }, { status: 501 });
    }
    const warnings: string[] = [];
    if (result.error || result.status !== 0) {
      const reason = (result.error?.message || result.stderr || result.stdout || `ocrmypdf exited ${result.status}`).toString().trim();
      // ocrmypdf can still write the sidecar text even on a non-zero exit.
      warnings.push(`ocrmypdf: ${reason.slice(0, 400)}`);
      console.warn("[ocr-text] ocrmypdf non-zero", { status: result.status, reason: reason.slice(0, 400) });
    }

    const text = existsSync(sidecarPath) ? readFileSync(sidecarPath, "utf8") : "";
    const pages = text ? text.split("\f").filter((p) => p.trim().length > 0).length || text.split("\f").length : 0;
    const trimmed = text.trim();
    // Coarse confidence from average characters per page.
    const confidence = trimmed.length === 0 ? 0 : Math.max(10, Math.min(95, Math.round(trimmed.length / Math.max(1, pages) / 8)));

    console.info("[ocr-text] result", {
      fileName,
      status: result.status,
      textLength: trimmed.length,
      pages,
      confidence,
      sample: trimmed.slice(0, 500),
    });

    return NextResponse.json({ text, pages, confidence, warnings });
  } catch (error) {
    console.error("[ocr-text] failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: `OCR failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

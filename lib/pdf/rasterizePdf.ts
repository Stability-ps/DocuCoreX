// Renders scanned-PDF pages to PNG images for OpenAI vision. Requires native
// tooling (poppler `pdftoppm`), which exists on the conversion worker Docker
// image but NOT on Vercel serverless — so `rasterizationAvailable()` gates it and
// callers fall back to Tesseract when it is unavailable. No content is logged.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RasterPage = { page: number; width: number; height: number; dataUrl: string };

// Pure: parse a PNG's pixel dimensions from its IHDR chunk (bytes 16–24).
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Pure: build a base64 data URL for an image buffer.
export function toPngDataUrl(png: Uint8Array): string {
  const b64 = Buffer.from(png).toString("base64");
  return `data:image/png;base64,${b64}`;
}

export function rasterizationAvailable(): boolean {
  try {
    const probe = spawnSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return probe.status === 0 || probe.status === 1; // -v prints to stderr, exit varies by build
  } catch {
    return false;
  }
}

// LIVE / worker-only. Renders up to `maxPages` pages at `dpi` and returns image
// data URLs. Returns [] when the tooling is unavailable so callers degrade to
// Tesseract rather than throwing.
export function rasterizePdfToImages(
  pdfBytes: Uint8Array,
  options: { dpi?: number; maxPages?: number } = {},
): RasterPage[] {
  if (!rasterizationAvailable()) return [];
  const dpi = options.dpi ?? 150;
  const maxPages = options.maxPages ?? 10;
  const dir = mkdtempSync(join(tmpdir(), "docx-raster-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, pdfBytes);
    const result = spawnSync(
      "pdftoppm",
      ["-png", "-r", String(dpi), "-f", "1", "-l", String(maxPages), pdfPath, join(dir, "page")],
      { stdio: "ignore" },
    );
    if (result.status !== 0) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((file, index) => {
        const png = new Uint8Array(readFileSync(join(dir, file)));
        const { width, height } = pngDimensions(png);
        return { page: index + 1, width, height, dataUrl: toPngDataUrl(png) };
      });
  } catch {
    return [];
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

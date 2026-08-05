import { NextResponse } from "next/server";
import { ocrBinaryHealth, runOcrText } from "@/lib/pdf/ocrEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HTTP wrapper around the shared OCR implementation in lib/pdf/ocrEngine.ts.
// This route holds NO OCR logic of its own — it only handles auth, multipart
// parsing, and mapping the engine result onto a response. The same engine is
// called directly (no HTTP hop) by lib/pdf/extractWithOcr.ts when the pipeline
// runs on the conversion worker itself.
//
// Manual test:
//   curl -F "file=@sample.pdf" \
//     -H "x-docucorex-worker-secret: $CONVERSION_WORKER_SECRET" \
//     https://<conversion-worker-url>/api/ocr-text
//   GET the same URL to check the OCR binaries.

function authorized(request: Request): boolean {
  if (process.env.CONVERSION_WORKER_MODE !== "true") return true;
  const configured = process.env.CONVERSION_WORKER_SECRET?.trim();
  if (!configured) return true;
  const provided = request.headers.get("x-docucorex-worker-secret")?.trim();
  return provided === configured;
}

// GET → OCR binary health check.
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized worker request" }, { status: 401 });
  return NextResponse.json(ocrBinaryHealth());
}

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

  // One call, one implementation. Status and body come straight from the engine
  // so the HTTP contract stays byte-identical to the in-process result.
  const result = runOcrText(fileBytes, fileName, endpoint);
  return NextResponse.json(result.body, { status: result.status });
}

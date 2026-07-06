import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";

type OcrTextBody = {
  runId?: string;
  documentId?: string;
  storagePath?: string;
  forceReprocess?: boolean;
};

type OcrResult = {
  text?: string;
  characters?: number;
  cached?: boolean;
  ocr_debug?: Record<string, unknown>;
  detail?: unknown;
  error?: string;
  [key: string]: unknown;
};

const defaultWorkerTimeoutMs = 4 * 60 * 1000;

function getWorkerOrigin(workerUrl: string) {
  try {
    return new URL(workerUrl).origin;
  } catch {
    return "invalid-worker-url";
  }
}

async function callWorker(
  workerUrl: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ response: Response; data: OcrResult; raw: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("ocr-worker-timeout"), timeoutMs);
  const response = await fetch(`${workerUrl.replace(/\/$/, "")}/ocr-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ACCOUNTING_WORKER_TOKEN ? { Authorization: `Bearer ${process.env.ACCOUNTING_WORKER_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const raw = await response.text();
  let data: OcrResult = {};
  try {
    data = raw ? (JSON.parse(raw) as OcrResult) : {};
  } catch {
    data = { detail: raw };
  }
  return { response, data, raw };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as OcrTextBody;
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerUrl = process.env.ACCOUNTING_WORKER_URL;
  if (!workerUrl) {
    return NextResponse.json({ error: "Accounting worker is not configured." }, { status: 503 });
  }

  let storagePath = body.storagePath ?? null;
  let documentId = body.documentId ?? null;
  if (body.runId) {
    const detail = await getAccountingRunDetail(body.runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }
    storagePath = detail.run.sourceStoragePath;
    documentId = detail.run.documentId;
  }

  if (!storagePath) {
    return NextResponse.json({ error: "runId or storagePath is required." }, { status: 400 });
  }

  const payload = {
    workspace_id: context.workspaceId,
    document_id: documentId,
    storage_path: storagePath,
    force_reprocess: Boolean(body.forceReprocess),
  };

  try {
    const timeoutMs = Number(process.env.ACCOUNTING_OCR_TIMEOUT_MS || defaultWorkerTimeoutMs);
    let attempt = await callWorker(workerUrl, payload, timeoutMs);
    if (!attempt.response.ok && (attempt.response.status === 502 || attempt.response.status === 504)) {
      attempt = await callWorker(workerUrl, payload, timeoutMs);
    }

    if (!attempt.response.ok) {
      const detail =
        typeof attempt.data.error === "string"
          ? attempt.data.error
          : typeof attempt.data.detail === "string"
            ? attempt.data.detail
            : attempt.raw.slice(0, 1000) || "OCR request failed.";
      return NextResponse.json(
        {
          error: detail,
          workerStatus: attempt.response.status,
          workerOrigin: getWorkerOrigin(workerUrl),
          ocrDebug: attempt.data.ocr_debug ?? null,
          detail: attempt.data.detail ?? null,
        },
        { status: attempt.response.status },
      );
    }

    return NextResponse.json({
      ok: true,
      text: attempt.data.text ?? "",
      characters: attempt.data.characters ?? 0,
      cached: Boolean(attempt.data.cached),
      ocrDebug: attempt.data.ocr_debug ?? {},
      workerOrigin: getWorkerOrigin(workerUrl),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR request failed.";
    const timeoutError = message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout");
    return NextResponse.json(
      { error: timeoutError ? "OCR timed out while processing this PDF." : message },
      { status: timeoutError ? 504 : 500 },
    );
  }
}

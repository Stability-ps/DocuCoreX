import { NextResponse, after } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { ocrResults } from "@/lib/mock-repository";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";
import { getDocumentWithJobs, getOcrForWorkspace, getWorkspaceContext } from "@/lib/server-documents";
import { resolveJobAction, findActiveJob, createRunningJob, runOcrJob, reclaimStaleJobs, cancelActiveJobs } from "@/lib/ocr/asyncJobs";

function isReprocess(url: string): boolean {
  return new URL(url).searchParams.get("reprocess") === "1";
}

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const result = await getOcrForWorkspace(documentId);

  if (result) {
    return NextResponse.json({ ocr: result, status: "completed" });
  }

  // No result yet — report the current job status so the UI can poll.
  const context = await getWorkspaceContext().catch(() => null);
  if (context) {
    const active = await findActiveJob(context, documentId, "ocr");
    if (active) {
      return NextResponse.json({ documentId, status: active.status === "running" ? "processing" : active.status, jobId: active.id });
    }
  }
  return NextResponse.json({ documentId, status: "queued", message: "OCR has not started for this document yet." });
}

export async function POST(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const force = isReprocess(request.url);
  const workspaceDocument = await getDocumentWithJobs(documentId);

  if (!workspaceDocument?.document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const context = await getWorkspaceContext();

  // Demo mode (no Supabase backend): keep the fast in-memory synchronous path.
  if (!context) {
    const adapters = createWorkflowAdapters();
    const ocr = await adapters.ocr.run(workspaceDocument.document);
    ocrResults.unshift(ocr);
    await recordAuditLog({ action: "extraction_completed", entityType: "document", entityId: documentId, metadata: { stage: "ocr", provider: adapters.ocr.name, confidence: ocr.confidence } });
    return NextResponse.json({ ocr, job: { id: `job_ocr_${Date.now()}`, documentId, type: "ocr", status: "completed", progress: 100, message: "OCR completed" }, mode: "demo" });
  }

  // Reclaim any stalled job (dead worker) so it neither blocks the unique-active
  // index nor leaves the document stuck; on explicit reprocess, cancel the active
  // job so the fresh one does not violate the index.
  await reclaimStaleJobs(context, documentId, "ocr");
  if (force) await cancelActiveJobs(context, documentId, "ocr");

  // Idempotent async processing: reuse a completed result, attach to an in-flight
  // job, or create a new one — never duplicate work for the same document+op.
  const existing = force ? null : await getOcrForWorkspace(documentId);
  const active = await findActiveJob(context, documentId, "ocr");
  const action = resolveJobAction({ hasCompletedResult: Boolean(existing), activeJobId: active?.id ?? null, force });

  if (action === "reuse") {
    return NextResponse.json({ ocr: existing, status: "completed", reused: true });
  }
  if (action === "attach") {
    return NextResponse.json({ documentId, jobId: active!.id, status: active!.status === "running" ? "processing" : active!.status, attached: true }, { status: 202 });
  }

  // Create the job and process it AFTER the response — the browser is not held
  // open while Render OCR runs (~43s).
  const job = await createRunningJob(context, documentId, "ocr");
  const document = workspaceDocument.document;
  after(async () => {
    await runOcrJob(context, document, job.id);
  });
  return NextResponse.json({ documentId, jobId: job.id, status: "processing" }, { status: 202 });
}

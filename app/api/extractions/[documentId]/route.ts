import { NextResponse, after } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { extractionResults } from "@/lib/mock-repository";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";
import { getDocumentWithJobs, getExtractionForWorkspace, getWorkspaceContext } from "@/lib/server-documents";
import { resolveJobAction, findActiveJob, createRunningJob, runExtractionJob, reclaimStaleJobs, cancelActiveJobs } from "@/lib/ocr/asyncJobs";

function isReprocess(url: string): boolean {
  return new URL(url).searchParams.get("reprocess") === "1";
}

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const result = await getExtractionForWorkspace(documentId);

  if (result) {
    return NextResponse.json({ extraction: result, status: "completed" });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (context) {
    const active = await findActiveJob(context, documentId, "extraction");
    if (active) {
      return NextResponse.json({ documentId, status: active.status === "running" ? "processing" : active.status, jobId: active.id });
    }
  }
  return NextResponse.json({ documentId, status: "queued", message: "Extraction has not started for this document yet." });
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
    const extraction = await adapters.extraction.run(workspaceDocument.document);
    extractionResults.unshift(extraction);
    await recordAuditLog({ action: "extraction_completed", entityType: "document", entityId: documentId, metadata: { provider: adapters.extraction.name, confidence: extraction.confidence } });
    return NextResponse.json({ extraction, job: { id: `job_extraction_${Date.now()}`, documentId, type: "extraction", status: "completed", progress: 100, message: "Extraction completed" }, mode: "demo" });
  }

  // Reclaim any stalled job (dead worker); on explicit reprocess, cancel the
  // active job so the fresh one does not violate the one-active-job index.
  await reclaimStaleJobs(context, documentId, "extraction");
  if (force) await cancelActiveJobs(context, documentId, "extraction");

  // Idempotent async processing: reuse a completed result, attach to an in-flight
  // job, or create a new one — never duplicate work for the same document+op.
  const existing = force ? null : await getExtractionForWorkspace(documentId);
  const active = await findActiveJob(context, documentId, "extraction");
  const action = resolveJobAction({ hasCompletedResult: Boolean(existing), activeJobId: active?.id ?? null, force });

  if (action === "reuse") {
    return NextResponse.json({ extraction: existing, status: "completed", reused: true });
  }
  if (action === "attach") {
    return NextResponse.json({ documentId, jobId: active!.id, status: active!.status === "running" ? "processing" : active!.status, attached: true }, { status: 202 });
  }

  const job = await createRunningJob(context, documentId, "extraction");
  const document = workspaceDocument.document;
  after(async () => {
    await runExtractionJob(context, document, job.id);
  });
  return NextResponse.json({ documentId, jobId: job.id, status: "processing" }, { status: 202 });
}

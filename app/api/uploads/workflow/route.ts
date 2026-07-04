import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getWorkspaceContext } from "@/lib/server-documents";

type ConversionTarget = "pdf" | "word" | "excel" | "zip";

const supportedTargets = new Set<ConversionTarget>(["pdf", "word", "excel", "zip"]);
const activeDocumentStatuses = ["uploaded", "queued", "processing", "ready", "review"];

function getSourceFormat(mimeType: string, name: string) {
  const lower = `${mimeType} ${name}`.toLowerCase();
  if (lower.includes("pdf") || name.toLowerCase().endsWith(".pdf")) return "pdf";
  if (lower.includes("word") || /\.(docx?|rtf|txt)$/i.test(name)) return "word";
  if (lower.includes("excel") || lower.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(name)) return "excel";
  if (lower.includes("image") || /\.(png|jpe?g|tiff?|bmp|gif|heic)$/i.test(name)) return "image";
  return "pdf";
}

function stateFromJobs(
  jobs: Array<{ status: string; type: string; progress: number; message: string }>,
  conversion?: { status?: string; download_path?: string | null } | null,
) {
  const failed = jobs.find((job) => job.status === "failed");
  if (failed) {
    return { uploadStatus: "uploaded", conversionStatus: "failed", outputReady: false, stage: displayJobMessage(failed.message) || "Failed", uploadProgress: 100, conversionProgress: Math.max(1, Math.min(99, failed.progress || 1)) };
  }

  if (conversion?.status === "output_ready" && conversion.download_path) {
    return { uploadStatus: "uploaded", conversionStatus: "completed", outputReady: true, stage: "Download ready", uploadProgress: 100, conversionProgress: 100 };
  }

  if (conversion?.status === "completed" && !conversion.download_path) {
    return { uploadStatus: "uploaded", conversionStatus: "failed", outputReady: false, stage: "Converted file is missing. Please retry.", uploadProgress: 100, conversionProgress: 1 };
  }

  if (conversion?.status === "failed") {
    return { uploadStatus: "uploaded", conversionStatus: "failed", outputReady: false, stage: "Conversion failed", uploadProgress: 100, conversionProgress: 1 };
  }

  const conversionJob = jobs.find((job) => job.type === "conversion" && (job.status === "queued" || job.status === "running"));
  if (conversionJob) {
    return {
      uploadStatus: "uploaded",
      conversionStatus: conversionJob.status === "running" ? "converting" : "queued",
      outputReady: false,
      stage: displayJobMessage(conversionJob.message) || "Converting",
      uploadProgress: 100,
      conversionProgress: conversionJob.progress,
    };
  }

  return { uploadStatus: "uploaded", conversionStatus: "ready", outputReady: false, stage: "Ready to convert", uploadProgress: 100, conversionProgress: 0 };
}

export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ items: [], mode: "demo" });
  }

  const { data: documents, error } = await context.supabase
    .from("documents")
    .select(
      "id, name, mime_type, size_bytes, status, storage_path, tags, created_at, updated_at, processing_jobs(id,type,status,progress,message,created_at,updated_at), conversions(id,from_format,to_format,status,download_path,created_at,updated_at)",
    )
    .eq("workspace_id", context.workspaceId)
    .contains("tags", ["Upload Queue"])
    .is("deleted_at", null)
    .in("status", activeDocumentStatuses)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: (documents ?? [])
      .filter((document) => !Array.isArray(document.tags) || !document.tags.includes("Converted"))
      .map((document) => {
      const jobs = Array.isArray(document.processing_jobs) ? document.processing_jobs : [];
      const conversions = Array.isArray(document.conversions) ? document.conversions : [];
      const latestConversion = conversions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      const state = stateFromJobs(jobs, latestConversion);

      return {
        id: document.id,
        documentId: document.id,
        name: document.name,
        mimeType: document.mime_type,
        size: document.size_bytes,
        storagePath: document.storage_path,
        documentStatus: document.status,
        uploadStatus: state.uploadStatus,
        conversionStatus: state.conversionStatus,
        outputReady: state.outputReady,
        stage: state.stage,
        uploadProgress: state.uploadProgress,
        conversionProgress: state.conversionProgress,
        conversion: latestConversion
          ? {
              id: latestConversion.id,
              from: latestConversion.from_format,
              to: latestConversion.to_format,
              status: latestConversion.status,
              downloadPath: latestConversion.download_path,
              outputReady: Boolean(state.outputReady),
              downloadUrl: state.outputReady ? `/api/download-file/${latestConversion.id}` : null,
            }
          : null,
        jobs: jobs.map((job) => ({ ...job, message: displayJobMessage(job.message) })),
        createdAt: document.created_at,
        updatedAt: document.updated_at,
      };
      }),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    documentIds?: string[];
    target?: ConversionTarget | "images";
  };

  if (!body.documentIds?.length) {
    return NextResponse.json({ error: "Select at least one uploaded document." }, { status: 400 });
  }

  if (body.target === "images") {
    return NextResponse.json({ error: "Image page export needs a PDF rendering provider before it can run." }, { status: 400 });
  }

  if (!body.target || !supportedTargets.has(body.target)) {
    return NextResponse.json({ error: "Choose a supported conversion target." }, { status: 400 });
  }
  const target = body.target;

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Supabase is required for live upload workflows." }, { status: 503 });
  }

  const { data: documents, error: documentError } = await context.supabase
    .from("documents")
    .select("id, name, mime_type, status, storage_path, tags, deleted_at")
    .eq("workspace_id", context.workspaceId)
    .contains("tags", ["Upload Queue"])
    .is("deleted_at", null)
    .in("status", activeDocumentStatuses)
    .in("id", body.documentIds);

  if (documentError) {
    return NextResponse.json({ error: documentError.message }, { status: 500 });
  }

  if (!documents?.length) {
    return NextResponse.json({ error: "No matching uploaded documents were found." }, { status: 404 });
  }

  const conversions = documents.map((document) => ({
    document_id: document.id,
    from_format: getSourceFormat(document.mime_type, document.name),
    to_format: target,
    status: "queued" as const,
  }));

  const { data: insertedConversions, error: conversionError } = await context.supabase
    .from("conversions")
    .insert(conversions)
    .select("id, document_id, from_format, to_format, status, download_path, created_at");

  if (conversionError) {
    return NextResponse.json({ error: conversionError.message }, { status: 500 });
  }

  const conversionByDocument = new Map((insertedConversions ?? []).map((conversion) => [conversion.document_id, conversion.id]));

  const { data: jobs, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert(
      documents.map((document) => ({
        document_id: document.id,
        type: "conversion",
        status: "queued",
        progress: 0,
        message: conversionJobMessage(getSourceFormat(document.mime_type, document.name), target, conversionByDocument.get(document.id) ?? ""),
      })),
    )
    .select("id, document_id, type, status, progress, message, created_at, updated_at");

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  await Promise.all(
    (insertedConversions ?? []).map((conversion) =>
      recordAuditLog({
        action: "conversion_started",
        entityType: "conversion",
        entityId: conversion.id,
        metadata: { documentId: conversion.document_id, from: conversion.from_format, to: conversion.to_format },
      }),
    ),
  );

  console.info("docucorex.conversion.batch_created", {
    conversions: (insertedConversions ?? []).map((conversion) => ({
      conversionId: conversion.id,
      documentId: conversion.document_id,
      from: conversion.from_format,
      to: conversion.to_format,
      status: conversion.status,
    })),
    jobs: (jobs ?? []).map((job) => ({
      jobId: job.id,
      documentId: job.document_id,
      message: displayJobMessage(job.message),
      conversionId: getConversionIdFromMessage(job.message),
    })),
  });

  return NextResponse.json({ conversions: insertedConversions ?? [], jobs: jobs ?? [] });
}

function conversionJobMessage(from: string, to: string, conversionId: string) {
  return conversionId ? `Convert ${from} to ${to} · conversion:${conversionId}` : `Convert ${from} to ${to}`;
}

function displayJobMessage(message: string) {
  return message.replace(/\s+·\s+conversion:[0-9a-f-]{36}\b/i, "");
}

function getConversionIdFromMessage(message: string) {
  return message.match(/\bconversion:([0-9a-f-]{36})\b/i)?.[1] ?? null;
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { documentId?: string };

  if (!body.documentId) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Supabase is required for live upload workflows." }, { status: 503 });
  }

  const now = new Date().toISOString();
  const { data: document, error: documentError } = await context.supabase
    .from("documents")
    .select("id, tags")
    .eq("workspace_id", context.workspaceId)
    .eq("id", body.documentId)
    .contains("tags", ["Upload Queue"])
    .maybeSingle();

  if (documentError) {
    return NextResponse.json({ error: documentError.message }, { status: 500 });
  }

  if (!document) {
    return NextResponse.json({ removed: true });
  }

  await context.supabase
    .from("processing_jobs")
    .update({ status: "cancelled", progress: 100, message: "Removed from upload queue", updated_at: now })
    .eq("document_id", body.documentId)
    .in("status", ["queued", "running", "failed"]);

  await context.supabase
    .from("conversions")
    .update({ status: "cancelled", updated_at: now })
    .eq("document_id", body.documentId)
    .in("status", ["queued", "running", "failed"]);

  await context.supabase.from("uploads").update({ status: "cancelled" }).eq("document_id", body.documentId).eq("workspace_id", context.workspaceId);

  await context.supabase
    .from("documents")
    .update({ deleted_at: now, updated_at: now })
    .eq("workspace_id", context.workspaceId)
    .eq("id", body.documentId);

  return NextResponse.json({ removed: true });
}

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getWorkspaceContext } from "@/lib/server-documents";

type ConversionTarget = "pdf" | "word" | "excel" | "zip";

const supportedTargets = new Set<ConversionTarget>(["pdf", "word", "excel", "zip"]);

function getSourceFormat(mimeType: string, name: string) {
  const lower = `${mimeType} ${name}`.toLowerCase();
  if (lower.includes("pdf") || name.toLowerCase().endsWith(".pdf")) return "pdf";
  if (lower.includes("word") || /\.(docx?|rtf|txt)$/i.test(name)) return "word";
  if (lower.includes("excel") || lower.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(name)) return "excel";
  if (lower.includes("image") || /\.(png|jpe?g|tiff?|bmp|gif|heic)$/i.test(name)) return "image";
  return "pdf";
}

function statusFromJobs(jobs: Array<{ status: string; type: string; progress: number; message: string }>) {
  const failed = jobs.find((job) => job.status === "failed");
  if (failed) return { status: "failed", stage: failed.message || "Failed", progress: 100 };
  const running = jobs.find((job) => job.status === "running");
  if (running) return { status: "processing", stage: running.message || running.type, progress: running.progress };
  const queued = jobs.find((job) => job.status === "queued");
  if (queued) return { status: "queued", stage: queued.message || queued.type, progress: queued.progress };
  return { status: "completed", stage: "Completed", progress: 100 };
}

export async function GET() {
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ items: [], mode: "demo" });
  }

  const { data: documents, error } = await context.supabase
    .from("documents")
    .select(
      "id, name, mime_type, size_bytes, status, storage_path, created_at, updated_at, processing_jobs(id,type,status,progress,message,created_at,updated_at), conversions(id,from_format,to_format,status,download_path,created_at,updated_at)",
    )
    .eq("workspace_id", context.workspaceId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: (documents ?? []).map((document) => {
      const jobs = Array.isArray(document.processing_jobs) ? document.processing_jobs : [];
      const conversions = Array.isArray(document.conversions) ? document.conversions : [];
      const state = statusFromJobs(jobs);
      const latestConversion = conversions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

      return {
        id: document.id,
        documentId: document.id,
        name: document.name,
        mimeType: document.mime_type,
        size: document.size_bytes,
        storagePath: document.storage_path,
        documentStatus: document.status,
        status: latestConversion?.status === "completed" ? "completed" : state.status,
        stage: latestConversion?.status === "completed" ? "Completed" : state.stage,
        progress: latestConversion?.status === "completed" ? 100 : state.progress,
        conversion: latestConversion
          ? {
              id: latestConversion.id,
              from: latestConversion.from_format,
              to: latestConversion.to_format,
              status: latestConversion.status,
              downloadPath: latestConversion.download_path,
              downloadUrl: `/api/download-file/${latestConversion.id}`,
            }
          : null,
        jobs,
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

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Supabase is required for live upload workflows." }, { status: 503 });
  }

  const { data: documents, error: documentError } = await context.supabase
    .from("documents")
    .select("id, name, mime_type")
    .eq("workspace_id", context.workspaceId)
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
    to_format: body.target as ConversionTarget,
    status: "queued" as const,
  }));

  const { data: insertedConversions, error: conversionError } = await context.supabase
    .from("conversions")
    .insert(conversions)
    .select("id, document_id, from_format, to_format, status, download_path, created_at");

  if (conversionError) {
    return NextResponse.json({ error: conversionError.message }, { status: 500 });
  }

  const { data: jobs, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert(
      documents.map((document) => ({
        document_id: document.id,
        type: "conversion",
        status: "queued",
        progress: 0,
        message: `Convert ${getSourceFormat(document.mime_type, document.name)} to ${body.target}`,
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

  return NextResponse.json({ conversions: insertedConversions ?? [], jobs: jobs ?? [] });
}

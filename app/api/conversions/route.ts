import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import type { ConversionRequest } from "@/lib/types";
import { createProcessingJob, getDocument, processingJobs } from "@/lib/mock-repository";
import { getDocumentWithJobs, getWorkspaceContext } from "@/lib/server-documents";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as ConversionRequest | null;

  if (!body?.documentId || !body.from || !body.to) {
    return NextResponse.json({ error: "documentId, from and to are required" }, { status: 400 });
  }

  const context = await getWorkspaceContext();

  if (!context) {
    const document = getDocument(body.documentId);

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const job = createProcessingJob(body.documentId, "conversion", `Convert ${body.from} to ${body.to}`);
    processingJobs.unshift(job);
    await recordAuditLog({
      action: "conversion_started",
      entityType: "conversion",
      entityId: job.id,
      metadata: { documentId: body.documentId, from: body.from, to: body.to, provider: "mock" },
    });

    return NextResponse.json({
      conversion: {
        id: `conversion_${Date.now()}`,
        documentId: body.documentId,
        from: body.from,
        to: body.to,
        status: "queued",
        downloadUrl: null,
        job,
      },
    });
  }

  const existing = await getDocumentWithJobs(body.documentId);

  if (!existing) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const { data: conversion, error: conversionError } = await context.supabase
    .from("conversions")
    .insert({
      document_id: body.documentId,
      from_format: body.from,
      to_format: body.to,
      status: "queued",
    })
    .select("id, document_id, from_format, to_format, status, download_path, created_at")
    .single();

  if (conversionError || !conversion) {
    return NextResponse.json({ error: conversionError?.message ?? "Unable to create conversion" }, { status: 500 });
  }

  const { data: job, error: jobError } = await context.supabase
    .from("processing_jobs")
    .insert({
      document_id: body.documentId,
      type: "conversion",
      status: "queued",
      progress: 0,
      message: `Convert ${body.from} to ${body.to}`,
    })
    .select("id, document_id, type, status, progress, message, created_at, updated_at")
    .single();

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  await recordAuditLog({
    action: "conversion_started",
    entityType: "conversion",
    entityId: conversion.id,
    metadata: { documentId: body.documentId, from: body.from, to: body.to },
  });

  return NextResponse.json({
    conversion: {
      id: conversion.id,
      documentId: conversion.document_id,
      from: conversion.from_format,
      to: conversion.to_format,
      status: conversion.status,
      downloadUrl: conversion.download_path,
      job: job
        ? {
            id: job.id,
            documentId: job.document_id,
            type: job.type,
            status: job.status,
            progress: job.progress,
            message: job.message,
            createdAt: job.created_at,
            updatedAt: job.updated_at,
          }
        : null,
    },
  });
}

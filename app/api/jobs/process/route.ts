import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import {
  documentDownloads,
  documentRecords,
  extractionResults,
  ocrResults,
  processingJobs,
} from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";
import type { DocumentRecord, ProcessingJob } from "@/lib/types";
import { createWorkflowAdapters } from "@/lib/workflow-adapters";

export async function POST() {
  const context = await getWorkspaceContext().catch(() => null);
  const providers = createWorkflowAdapters();

  if (!context) {
    return NextResponse.json(await processDemoJobs(providers));
  }

  const { data: jobs, error } = await context.supabase
    .from("processing_jobs")
    .select("id, document_id, type, status, progress, message, documents!inner(*)")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = [];

  for (const job of jobs ?? []) {
    const document = mapSupabaseDocument(job.documents);

    if (!document || document.workspaceId !== context.workspaceId) {
      results.push({ jobId: job.id, status: "skipped", reason: "Document not found" });
      continue;
    }

    if (document.deletedAt || document.status === "archived") {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "cancelled", progress: 100, message: "Document is no longer active", updated_at: new Date().toISOString() })
        .eq("id", job.id);
      results.push({ jobId: job.id, status: "cancelled", reason: "Document is no longer active" });
      continue;
    }

    try {
      await context.supabase
        .from("processing_jobs")
        .update({ status: "running", progress: 35, message: getRunningMessage(job.type), updated_at: new Date().toISOString() })
        .eq("id", job.id);

      if (job.type === "upload") {
        await context.supabase
          .from("processing_jobs")
          .update({ status: "completed", progress: 100, message: "Upload registered", updated_at: new Date().toISOString() })
          .eq("id", job.id);

        await context.supabase.from("documents").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", document.id);

        await context.supabase.from("processing_jobs").insert([
          { document_id: document.id, type: "ocr", status: "queued", progress: 0, message: "OCR queued" },
          { document_id: document.id, type: "extraction", status: "queued", progress: 0, message: "Extraction queued" },
        ]);

        results.push({ jobId: job.id, type: job.type, status: "completed" });
        continue;
      }

      if (job.type === "ocr") {
        const ocr = await providers.ocr.run(document);
        await context.supabase.from("ocr_results").insert({
          document_id: document.id,
          language: ocr.language,
          confidence: ocr.confidence,
          text: ocr.text,
          layout: { status: ocr.layoutStatus, provider: providers.ocr.name },
        });
        const { data: existingExtraction } = await context.supabase
          .from("extraction_results")
          .select("id")
          .eq("document_id", document.id)
          .limit(1)
          .maybeSingle();

        if (document.status !== "ready" && !existingExtraction) {
          await context.supabase.from("documents").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", document.id);
        }
        await recordAuditLog({
          action: "extraction_completed",
          entityType: "document",
          entityId: document.id,
          metadata: { stage: "ocr", provider: providers.ocr.name, confidence: ocr.confidence },
        });
      }

      if (job.type === "extraction") {
        const extraction = await providers.extraction.run(document);
        await context.supabase.from("extraction_results").insert({
          document_id: document.id,
          detected_type: extraction.detectedType,
          confidence: extraction.confidence,
          fields: extraction.fields,
          line_items: extraction.lineItems,
        });
        await context.supabase.from("documents").update({ status: "ready", detected_type: extraction.detectedType, updated_at: new Date().toISOString() }).eq("id", document.id);
        await recordAuditLog({
          action: "extraction_completed",
          entityType: "document",
          entityId: document.id,
          metadata: { provider: providers.extraction.name, confidence: extraction.confidence },
        });
      }

      if (job.type === "conversion") {
        const conversion = await getNextQueuedConversion(context, document.id);
        const toFormat = conversion?.to_format ?? getTargetFormat(job.message);
        if (conversion) {
          await context.supabase
            .from("conversions")
            .update({ status: "running", updated_at: new Date().toISOString() })
            .eq("id", conversion.id);
        }
        const { data: sourceFile, error: sourceError } = await context.supabase.storage.from("documents").download(document.storagePath);
        if (sourceError || !sourceFile) {
          throw new Error(sourceError?.message ?? "Original file could not be downloaded for conversion.");
        }

        await context.supabase
          .from("processing_jobs")
          .update({ status: "running", progress: 55, message: "Extracting document content", updated_at: new Date().toISOString() })
          .eq("id", job.id);

        const converted = await providers.conversion.run(
          { ...document, sourceContent: new Uint8Array(await sourceFile.arrayBuffer()) } as DocumentRecord & { sourceContent: Uint8Array },
          { toFormat },
        );

        validateConvertedFile(converted);

        const upload = await context.supabase.storage
          .from("documents")
          .upload(converted.downloadPath, new Blob([Buffer.from(converted.content)], { type: converted.contentType }), {
            contentType: converted.contentType,
            upsert: true,
          });

        if (upload.error) {
          throw new Error(upload.error.message);
        }

        if (conversion) {
          await context.supabase
            .from("conversions")
            .update({ status: "completed", download_path: converted.downloadPath, updated_at: new Date().toISOString() })
            .eq("id", conversion.id);
        }

        const { data: convertedDocument } = await context.supabase
          .from("documents")
          .insert({
            workspace_id: context.workspaceId,
            owner_id: context.userId,
            name: converted.fileName,
            mime_type: converted.contentType,
            size_bytes: converted.content.length,
            page_count: 1,
            status: "ready",
            detected_type: document.detectedType,
            storage_path: converted.downloadPath,
            tags: ["Converted", toFormat],
          })
          .select("id")
          .single();

        if (convertedDocument?.id) {
          await context.supabase.from("document_versions").insert({
            document_id: convertedDocument.id,
            version_number: 1,
            storage_path: converted.downloadPath,
            change_note: `Converted from ${document.name}`,
            created_by: context.userId,
          });

          await context.supabase.from("uploads").insert({
            workspace_id: context.workspaceId,
            document_id: convertedDocument.id,
            file_name: converted.fileName,
            mime_type: converted.contentType,
            size_bytes: converted.content.length,
            storage_path: converted.downloadPath,
            status: "completed",
            created_by: context.userId,
          });
        }

        await recordAuditLog({
          action: "conversion_completed",
          entityType: "conversion",
          entityId: conversion?.id ?? null,
          metadata: { documentId: document.id, provider: providers.conversion.name, toFormat, downloadPath: converted.downloadPath },
        });
      }

      await context.supabase
        .from("processing_jobs")
        .update({ status: "completed", progress: 100, message: getCompletedMessage(job.type), updated_at: new Date().toISOString() })
        .eq("id", job.id);

      results.push({ jobId: job.id, type: job.type, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Job failed";
      if (job.type === "conversion") {
        await failQueuedConversion(context, document.id, message);
      }
      await context.supabase
        .from("processing_jobs")
        .update({ status: "failed", progress: 100, message, error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
      results.push({ jobId: job.id, type: job.type, status: "failed", message });
    }
  }

  return NextResponse.json({ processed: results.length, results, providers: providers.detection });
}

export async function GET() {
  return POST();
}

async function processDemoJobs(providers: ReturnType<typeof createWorkflowAdapters>) {
  const queued = processingJobs.filter((job) => job.status === "queued" || job.status === "running").slice(0, 10);
  const results = [];

  for (const job of queued) {
    const document = documentRecords.find((item) => item.id === job.documentId);

    if (!document) {
      job.status = "failed";
      job.progress = 100;
      job.message = "Document not found";
      results.push({ jobId: job.id, status: "failed" });
      continue;
    }

    job.status = "running";
    job.progress = 35;
    job.updatedAt = new Date().toISOString();

    if (job.type === "upload") {
      job.status = "completed";
      job.progress = 100;
      job.message = "Upload registered";
      processingJobs.unshift({ ...job, id: `job_ocr_${Date.now()}`, type: "ocr", status: "queued", progress: 0, message: "OCR queued" });
      processingJobs.unshift({ ...job, id: `job_extraction_${Date.now()}`, type: "extraction", status: "queued", progress: 0, message: "Extraction queued" });
    }

    if (job.type === "ocr") {
      ocrResults.unshift(await providers.ocr.run(document));
      if (document.status !== "ready") {
        document.status = "processing";
      }
    }

    if (job.type === "extraction") {
      const extraction = await providers.extraction.run(document);
      extractionResults.unshift(extraction);
      document.status = "ready";
      document.detectedType = extraction.detectedType;
    }

    if (job.type === "conversion") {
      try {
        const sourceContent = new TextEncoder().encode(`Demo document content for ${document.name}`);
        const converted = await providers.conversion.run({ ...document, sourceContent } as DocumentRecord & { sourceContent: Uint8Array }, { toFormat: getTargetFormat(job.message) });
        documentDownloads.unshift({
          id: converted.id,
          documentId: document.id,
          label: converted.fileName,
          format: getDownloadFormat(converted.fileName),
          status: "ready",
          href: `/api/download-file/${converted.id}`,
          createdAt: new Date().toISOString(),
        });
        await recordAuditLog({
          action: "conversion_completed",
          entityType: "conversion",
          entityId: converted.id,
          metadata: { documentId: document.id, provider: providers.conversion.name },
        });
      } catch (conversionError) {
        job.status = "failed";
        job.progress = 100;
        job.message = conversionError instanceof Error ? conversionError.message : "Conversion failed";
        results.push({ jobId: job.id, type: job.type, status: "failed", message: job.message });
        continue;
      }
    }

    job.status = "completed";
    job.progress = 100;
    job.message = getCompletedMessage(job.type);
    job.updatedAt = new Date().toISOString();
    results.push({ jobId: job.id, type: job.type, status: "completed" });
  }

  return { processed: results.length, results, providers: providers.detection, mode: "demo" };
}

function mapSupabaseDocument(row: unknown): DocumentRecord | null {
  const document = Array.isArray(row) ? row[0] : (row as Record<string, unknown> | null);

  if (!document) return null;

  return {
    id: String(document.id),
    workspaceId: String(document.workspace_id),
    ownerId: String(document.owner_id),
    folderId: (document.folder_id as string | null) ?? null,
    name: String(document.name),
    mimeType: String(document.mime_type),
    sizeBytes: Number(document.size_bytes),
    pageCount: Number(document.page_count),
    status: document.status as DocumentRecord["status"],
    detectedType: document.detected_type as DocumentRecord["detectedType"],
    storagePath: String(document.storage_path),
    tags: Array.isArray(document.tags) ? (document.tags as string[]) : [],
    starred: Boolean(document.starred),
    shared: Boolean(document.shared),
    deletedAt: (document.deleted_at as string | null) ?? null,
    createdAt: String(document.created_at),
    updatedAt: String(document.updated_at),
  };
}

async function getNextQueuedConversion(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>, documentId: string) {
  const { data } = await context.supabase
    .from("conversions")
    .select("id, to_format")
    .eq("document_id", documentId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data;
}

async function failQueuedConversion(context: NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>, documentId: string, message: string) {
  await context.supabase
    .from("conversions")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("document_id", documentId)
    .in("status", ["queued", "running", "completed"]);
  await recordAuditLog({
    action: "document_conversion_failed",
    entityType: "document",
    entityId: documentId,
    metadata: { reason: message },
  });
}

function getTargetFormat(message: string) {
  const match = message.match(/\bto\s+([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() ?? "excel";
}

function getRunningMessage(type: ProcessingJob["type"]) {
  if (type === "ocr") return "Extracting text";
  if (type === "extraction") return "Analysing document fields";
  if (type === "conversion") return "Creating converted file";
  return "Processing";
}

function getCompletedMessage(type: ProcessingJob["type"]) {
  if (type === "ocr") return "OCR completed";
  if (type === "extraction") return "Extraction completed";
  if (type === "conversion") return "Conversion completed";
  return "Completed";
}

function getDownloadFormat(fileName: string) {
  const extension = fileName.split(".").pop();
  if (extension === "json" || extension === "txt" || extension === "pdf" || extension === "csv" || extension === "xlsx") {
    return extension;
  }
  return "txt";
}

function validateConvertedFile(file: { content?: Uint8Array; downloadPath?: string; fileName?: string }) {
  if (!file.downloadPath?.trim()) {
    throw new Error("Conversion failed because no output file path was produced.");
  }

  if (!file.content?.byteLength) {
    throw new Error("Conversion failed because the output file was empty.");
  }

  const sample = new TextDecoder("utf-8", { fatal: false }).decode(file.content.slice(0, Math.min(file.content.byteLength, 4096)));
  const metadataOnlyMarkers = [
    "DocuCoreX processed document",
    "Original Filename",
    "Original filename",
    "Original MIME type",
    "Detected type:",
    "Generated by DocuCoreX local conversion provider",
  ];

  if (metadataOnlyMarkers.some((marker) => sample.includes(marker))) {
    throw new Error("Conversion failed because no readable document content was extracted.");
  }
}

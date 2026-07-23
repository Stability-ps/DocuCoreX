import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getWorkspaceContext().catch(() => null);

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: conversion, error } = await context.supabase
    .from("conversions")
    .select("id, document_id, from_format, to_format, status, download_path, created_at, updated_at, documents!inner(workspace_id,name,storage_path)")
    .eq("id", id)
    .maybeSingle();

  const document = Array.isArray(conversion?.documents) ? conversion?.documents[0] : conversion?.documents;
  if (error || !conversion || !document || document.workspace_id !== context.workspaceId) {
    return NextResponse.json({ error: "Conversion not found" }, { status: 404 });
  }

  const { data: jobs } = await context.supabase
    .from("processing_jobs")
    .select("id, document_id, type, status, progress, message, error, created_at, updated_at")
    .eq("document_id", conversion.document_id)
    .eq("type", "conversion")
    .order("created_at", { ascending: false })
    .limit(10);

  const matchingJobs = (jobs ?? []).filter((job) => getConversionIdFromMessage(job.message) === conversion.id);
  const latestMatchingJob = matchingJobs[0] ?? null;
  const queuedJobAgeSeconds =
    latestMatchingJob?.status === "queued"
      ? Math.max(0, Math.floor((Date.now() - new Date(latestMatchingJob.created_at).getTime()) / 1000))
      : null;
  const storagePath = conversion.download_path as string | null;
  const fileCheck = storagePath
    ? await context.supabase.storage.from("documents").download(storagePath)
    : { data: null, error: null };
  const signedUrlCheck = storagePath
    ? await context.supabase.storage.from("documents").createSignedUrl(storagePath, 60)
    : { data: null, error: null };

  const workerHealth = await fetchWorkerHealth();

  console.info("docucorex.conversion.debug_trace", {
    conversionId: conversion.id,
    documentId: conversion.document_id,
    status: conversion.status,
    downloadPath: storagePath,
    storageBucket: "documents",
    storageFileExists: Boolean(fileCheck.data),
    signedUrlSuccess: Boolean(signedUrlCheck.data?.signedUrl),
    matchingJobIds: matchingJobs.map((job) => job.id),
    workerHealthStatus: workerHealth?.status ?? null,
  });

  return NextResponse.json({
    conversion: {
      id: conversion.id,
      documentId: conversion.document_id,
      from: conversion.from_format,
      to: conversion.to_format,
      status: conversion.status,
      downloadPath: storagePath,
      outputFilePath: storagePath,
      createdAt: conversion.created_at,
      updatedAt: conversion.updated_at,
    },
    document: {
      name: document.name,
      storagePath: document.storage_path,
    },
    jobs: (jobs ?? []).map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      message: displayJobMessage(job.message),
      hasConversionToken: getConversionIdFromMessage(job.message) === conversion.id,
      error: job.error,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
    storage: {
      bucket: "documents",
      path: storagePath,
      fileExists: Boolean(fileCheck.data),
      fileBytes: fileCheck.data?.size ?? 0,
      fileError: fileCheck.error?.message ?? null,
    },
    signedUrl: {
      success: Boolean(signedUrlCheck.data?.signedUrl),
      error: signedUrlCheck.error?.message ?? null,
    },
    processing: {
      processorMode: workerHealth?.workerMode === true ? "worker" : process.env.CONVERSION_WORKER_URL?.trim() ? "remote-worker" : "local",
      lastWorkerProcessAttempt: latestMatchingJob?.updated_at ?? null,
      lastWorkerProcessResponse: latestMatchingJob
        ? {
            jobId: latestMatchingJob.id,
            status: latestMatchingJob.status,
            progress: latestMatchingJob.progress,
            message: displayJobMessage(latestMatchingJob.message),
            error: latestMatchingJob.error ?? null,
          }
        : null,
      queuedJobAgeSeconds,
    },
    worker: workerHealth,
    app: {
      vercelCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      workerUrlConfigured: Boolean(process.env.CONVERSION_WORKER_URL?.trim()),
      workerHost: safeHost(process.env.CONVERSION_WORKER_URL),
    },
  });
}

async function fetchWorkerHealth() {
  const workerUrl = process.env.CONVERSION_WORKER_URL?.trim();
  if (!workerUrl) return { status: "not_configured" };

  try {
    const response = await fetch(new URL("/api/conversion-worker/health", workerUrl), { cache: "no-store" });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, ok: response.ok, ...body };
  } catch (error) {
    return { status: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}

function getConversionIdFromMessage(message: string) {
  return message.match(/\bconversion:([0-9a-f-]{36})\b/i)?.[1] ?? null;
}

function displayJobMessage(message: string) {
  return message.replace(/\s+·\s+conversion:[0-9a-f-]{36}\b/i, "");
}

function safeHost(value?: string) {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return "invalid-url";
  }
}

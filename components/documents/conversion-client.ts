"use client";

import type { DocumentDownload, ProcessingJob } from "@/lib/types";

export type StartedConversion = {
  conversionId: string;
  jobId: string;
  documentId: string;
};

type WorkflowResponse = {
  conversions?: Array<{ id: string; document_id: string; status: string }>;
  jobs?: Array<{ id: string; document_id: string; status: string; progress?: number; message?: string; error?: string | null }>;
  error?: string;
};

type DocumentResponse = {
  jobs?: ProcessingJob[];
};

type DownloadsResponse = {
  downloads?: DocumentDownload[];
  error?: string;
};

export async function createDocumentConversion(documentId: string, target: string): Promise<StartedConversion> {
  const response = await fetch("/api/uploads/workflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentIds: [documentId], target }),
  });

  const payload = (await response.json().catch(() => ({}))) as WorkflowResponse;
  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to start conversion.");
  }

  const conversion = payload.conversions?.find((item) => item.document_id === documentId);
  const job = payload.jobs?.find((item) => item.document_id === documentId);
  if (!conversion?.id || !job?.id) {
    throw new Error("Conversion was created without a matching processing job.");
  }

  return { conversionId: conversion.id, jobId: job.id, documentId };
}

export async function wakeConversionWorker(conversion: StartedConversion) {
  const response = await fetch("/api/jobs/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversion),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "The conversion worker could not start.";
    throw new Error(message);
  }
  return payload;
}

export async function waitForDownloadReady(
  conversion: StartedConversion,
  options: {
    onStatus?: (message: string) => void;
    timeoutMs?: number;
  } = {},
) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 90_000;
  let lastJob: ProcessingJob | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const [documentResponse, downloadsResponse] = await Promise.all([
      fetch(`/api/documents/${conversion.documentId}`, { cache: "no-store" }).catch(() => null),
      fetch(`/api/downloads/${conversion.documentId}`, { cache: "no-store" }).catch(() => null),
    ]);

    if (documentResponse?.ok) {
      const documentPayload = (await documentResponse.json().catch(() => ({}))) as DocumentResponse;
      lastJob = documentPayload.jobs?.find((job) => job.id === conversion.jobId) ?? lastJob;
      if (lastJob?.status === "failed") {
        const failedJob = lastJob as ProcessingJob & { error?: string | null };
        throw new Error(failedJob.error || failedJob.message || "Conversion failed.");
      }
      if (lastJob?.status === "queued" && Date.now() - startedAt > 30_000) {
        throw new Error("Worker did not start processing this conversion. Please retry in a moment.");
      }
      if (lastJob?.status === "running") {
        options.onStatus?.(`Converting… ${Math.max(1, Math.min(99, Number(lastJob.progress ?? 50)))}%`);
      } else if (lastJob?.status === "queued") {
        options.onStatus?.("Waiting for the conversion worker…");
      }
    }

    if (downloadsResponse?.ok) {
      const downloadsPayload = (await downloadsResponse.json().catch(() => ({}))) as DownloadsResponse;
      const readyDownload = downloadsPayload.downloads?.find(
        (download) => download.id === conversion.conversionId && download.status === "ready" && download.href,
      );
      if (readyDownload) return readyDownload;

      const failedDownload = downloadsPayload.downloads?.find(
        (download) => download.id === conversion.conversionId && download.status === "failed",
      );
      if (failedDownload) {
        throw new Error("Conversion failed before a downloadable output was created.");
      }
    }

    await sleep(2000);
  }

  throw new Error(lastJob?.message || "Conversion is taking longer than expected. Please check the document history and retry if needed.");
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

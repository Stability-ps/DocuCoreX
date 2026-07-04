import { NextResponse } from "next/server";
import { getDocumentDownloads } from "@/lib/mock-repository";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ downloads: getDocumentDownloads(documentId), mode: "demo" });
  }

  const { data, error } = await context.supabase
    .from("conversions")
    .select("id, document_id, from_format, to_format, status, download_path, created_at, updated_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const downloads = await Promise.all(
    (data ?? []).map(async (conversion) => {
      const signedUrl =
        conversion.status === "output_ready" && conversion.download_path
          ? await context.supabase.storage.from("documents").createSignedUrl(conversion.download_path, 60).catch((error) => ({
              data: null,
              error,
            }))
          : null;

      const signedUrlReady = Boolean(signedUrl?.data?.signedUrl);
      if (conversion.status === "output_ready") {
        console.info("docucorex.conversion.signed_url_check", {
          conversionId: conversion.id,
          documentId: conversion.document_id,
          supabaseBucket: "documents",
          supabasePath: conversion.download_path,
          signedUrlReady,
          error: signedUrl && "error" in signedUrl ? signedUrl.error?.message ?? String(signedUrl.error ?? "") : null,
        });
      }

      const missingOutput = conversion.status === "output_ready" && (!conversion.download_path || !signedUrlReady);
      return {
        id: conversion.id,
        documentId: conversion.document_id,
        label: `${conversion.to_format.toUpperCase()} export`,
        format: conversion.to_format === "excel" ? "xlsx" : conversion.to_format,
        status: conversion.status === "output_ready" && conversion.download_path && signedUrlReady ? "ready" : conversion.status === "failed" || missingOutput ? "failed" : "processing",
        href: conversion.status === "output_ready" && conversion.download_path && signedUrlReady ? `/api/download-file/${conversion.id}` : "",
        createdAt: conversion.created_at,
      };
    }),
  );

  return NextResponse.json({ downloads });
}

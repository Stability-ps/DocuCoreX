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

  return NextResponse.json({
    downloads: (data ?? []).map((conversion) => ({
      id: conversion.id,
      documentId: conversion.document_id,
      label: `${conversion.to_format.toUpperCase()} export`,
      format: conversion.to_format === "excel" ? "xlsx" : conversion.to_format,
      status: (conversion.status === "output_ready" || conversion.status === "completed") && conversion.download_path ? "ready" : conversion.status === "failed" || (conversion.status === "completed" && !conversion.download_path) ? "failed" : "processing",
      href: (conversion.status === "output_ready" || conversion.status === "completed") && conversion.download_path ? `/api/download-file/${conversion.id}` : "",
      createdAt: conversion.created_at,
    })),
  });
}

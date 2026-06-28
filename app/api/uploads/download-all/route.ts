import { NextResponse } from "next/server";
import { createZip } from "@/lib/file-output";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { conversionIds?: string[] };

  if (!body.conversionIds?.length) {
    return NextResponse.json({ error: "No completed conversions selected." }, { status: 400 });
  }

  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Supabase is required for download bundles." }, { status: 503 });
  }

  const { data: conversions, error } = await context.supabase
    .from("conversions")
    .select("id, to_format, download_path, documents!inner(workspace_id,name,status,deleted_at)")
    .in("id", body.conversionIds)
    .eq("status", "completed");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const entries = [];

  for (const conversion of conversions ?? []) {
    const document = Array.isArray(conversion.documents) ? conversion.documents[0] : conversion.documents;
    if (!document || document.workspace_id !== context.workspaceId || document.deleted_at || document.status === "archived" || !conversion.download_path) {
      continue;
    }

    const { data: fileData, error: fileError } = await context.supabase.storage.from("documents").download(conversion.download_path);
    if (fileError || !fileData) {
      continue;
    }

    entries.push({
      name: conversion.download_path.split("/").pop() ?? `${document.name}.${conversion.to_format}`,
      content: new Uint8Array(await fileData.arrayBuffer()),
    });
  }

  if (!entries.length) {
    return NextResponse.json({ error: "No completed converted files are ready to bundle." }, { status: 409 });
  }

  const zip = createZip(entries);

  return new NextResponse(zip, {
    headers: {
      "content-disposition": `attachment; filename="docucorex-converted-results.zip"`,
      "content-type": "application/zip",
    },
  });
}

import { NextResponse } from "next/server";
import { getDownload } from "@/lib/mock-repository";
import { isDemoAllowed } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

const mimeByFormat = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
  txt: "text/plain",
  pdf: "application/pdf",
  csv: "text/csv",
};

export async function GET(_request: Request, { params }: { params: Promise<{ downloadId: string }> }) {
  const { downloadId } = await params;
  const supabase = await createSupabaseServerClient();

  if (!supabase && isDemoAllowed) {
    return createDemoDownload(downloadId);
  }

  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("conversions")
    .select("id, from_format, to_format, status, download_path")
    .eq("id", downloadId)
    .single();

  if (error || !data) {
    if (isDemoAllowed) {
      return createDemoDownload(downloadId);
    }

    return NextResponse.json({ error: "Download not found" }, { status: 404 });
  }

  const format = data.to_format === "excel" ? "xlsx" : data.to_format;

  if (data.status !== "completed") {
    return NextResponse.json({ error: "Conversion is not ready for download" }, { status: 409 });
  }

  if (data.download_path) {
    const { data: fileData, error: fileError } = await supabase.storage.from("documents").download(data.download_path);

    if (fileError || !fileData) {
      return NextResponse.json({ error: fileError?.message ?? "Converted file not found" }, { status: 404 });
    }

    return new NextResponse(fileData, {
      headers: {
        "content-disposition": `attachment; filename="${downloadId}.${format}"`,
        "content-type": fileData.type || mimeByFormat[format as keyof typeof mimeByFormat] || "application/octet-stream",
      },
    });
  }

  const payload = `DocuCoreX export\nConversion ID: ${downloadId}\nStatus: ${data.status}\n`;

  return new NextResponse(payload, {
    headers: {
      "content-disposition": `attachment; filename="${downloadId}.${format}"`,
      "content-type": mimeByFormat[format as keyof typeof mimeByFormat] ?? "text/plain",
    },
  });
}

function createDemoDownload(downloadId: string) {
  const download = getDownload(downloadId);

  if (!download && !downloadId.startsWith("conversion_")) {
    return NextResponse.json({ error: "Download not found" }, { status: 404 });
  }

  const format = download?.format ?? "xlsx";
  const label = download?.label ?? "Converted document";
  const status = download?.status ?? "ready";
  const payload = `DocuCoreX export\nDownload: ${label}\nFormat: ${format}\nStatus: ${status}\n`;

  return new NextResponse(payload, {
    headers: {
      "content-disposition": `attachment; filename="${downloadId}.${format}"`,
      "content-type": mimeByFormat[format as keyof typeof mimeByFormat] ?? "text/plain",
    },
  });
}

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
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
};

export async function GET(request: Request, { params }: { params: Promise<{ downloadId: string }> }) {
  const { downloadId } = await params;
  const supabase = await createSupabaseServerClient();

  if (!supabase && isDemoAllowed) {
    return createDemoDownload(downloadId);
  }

  if (!supabase) {
    return downloadError(request, "Downloads are not configured for this workspace yet.", 503);
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

    return downloadError(request, "We could not find this converted file.", 404);
  }

  const format = data.to_format === "excel" ? "xlsx" : data.to_format === "word" ? "docx" : data.to_format;
  const isOutputReady = (data.status === "output_ready" || data.status === "completed") && Boolean(data.download_path);

  if (!isOutputReady) {
    return downloadError(request, "This conversion is still being prepared. Please wait for Download ready, then try again.", 409);
  }

  if (data.download_path) {
    const { data: fileData, error: fileError } = await supabase.storage.from("documents").download(data.download_path);

    if (fileError || !fileData) {
      await supabase.from("conversions").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", data.id);
      return downloadError(request, fileError?.message ?? "The converted file is missing. Please run the conversion again.", 404);
    }

    return new NextResponse(fileData, {
      headers: {
        "content-disposition": `attachment; filename="${downloadId}.${format}"`,
        "content-type": fileData.type || mimeByFormat[format as keyof typeof mimeByFormat] || "application/octet-stream",
      },
    });
  }

  return downloadError(request, "The converted file is missing. Please run the conversion again.", 409);
}

function createDemoDownload(downloadId: string) {
  const download = getDownload(downloadId);

  if (!download && !downloadId.startsWith("conversion_")) {
    return NextResponse.json({ error: "Download not found" }, { status: 404 });
  }

  const format = download?.format ?? "xlsx";
  const label = download?.label ?? "Converted document";
  const status = download?.status ?? "ready";
  const payload = `Demo converted content\nDownload: ${label}\nFormat: ${format}\nStatus: ${status}\nThis demo file contains sample converted content only.`;

  return new NextResponse(payload, {
    headers: {
      "content-disposition": `attachment; filename="${downloadId}.${format}"`,
      "content-type": mimeByFormat[format as keyof typeof mimeByFormat] ?? "text/plain",
    },
  });
}

function downloadError(request: Request, message: string, status: number) {
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");

  if (!acceptsHtml) {
    return NextResponse.json({ error: message }, { status });
  }

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Download unavailable - DocuCoreX</title>
    <style>
      body { margin: 0; font-family: Inter, Arial, sans-serif; background: #f8fafc; color: #0f172a; }
      main { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      section { max-width: 520px; border: 1px solid #e2e8f0; border-radius: 18px; background: white; padding: 28px; box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08); }
      h1 { margin: 0; font-size: 22px; }
      p { color: #475569; line-height: 1.6; }
      a { display: inline-flex; min-height: 42px; align-items: center; border-radius: 12px; background: #0057ff; color: white; padding: 0 16px; text-decoration: none; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Download not ready</h1>
        <p>${escapeHtml(message)}</p>
        <a href="/convert">Back to Convert Files</a>
      </section>
    </main>
  </body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

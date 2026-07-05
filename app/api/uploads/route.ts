import { NextRequest, NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getWorkspaceContext, registerUploads } from "@/lib/server-documents";
import { createWorkspaceBucketPath } from "@/lib/supabase-server-adapter";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rate = checkRateLimit(`upload:${ip}`, { limit: 30, windowMs: 60 * 1000 });
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Upload rate limit exceeded. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const uploadedFiles = Array.from(formData.entries())
      .filter(([key]) => key === "file")
      .map(([, value]) => value)
      .filter((value): value is File => value instanceof File);

    try {
      const context = await getWorkspaceContext();
      const files = [];

      for (const file of uploadedFiles) {
        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
          return NextResponse.json(
            { error: `${file.name} exceeds the 200 MB upload limit` },
            { status: 413 },
          );
        }
        const storagePath = context ? await createWorkspaceBucketPath(context.workspaceId, file.name) : undefined;

        if (context && storagePath) {
          const { error } = await context.supabase.storage.from("documents").upload(storagePath, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });

          if (error) {
            throw new Error(`${file.name}: ${error.message}`);
          }
        }

        files.push({ name: file.name, size: file.size, type: file.type, storagePath });
      }

      const result = await registerUploads(files);
      await Promise.all(
        result.accepted.map((file) =>
          recordAuditLog({
            action: "upload",
            entityType: "document",
            entityId: file.id,
            metadata: { fileName: file.name, sizeBytes: file.size, mimeType: file.mimeType },
          }),
        ),
      );
      return NextResponse.json(result);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to register upload" }, { status: 400 });
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    files?: Array<{ name: string; size: number; type: string; storagePath?: string }>;
  };

  const files = body.files ?? [];

  const oversized = files.find((f) => (f.size ?? 0) > MAX_UPLOAD_SIZE_BYTES);
  if (oversized) {
    return NextResponse.json(
      { error: `${oversized.name} exceeds the 200 MB upload limit` },
      { status: 413 },
    );
  }

  try {
    const result = await registerUploads(files);
    await Promise.all(
      result.accepted.map((file) =>
        recordAuditLog({
          action: "upload",
          entityType: "document",
          entityId: file.id,
          metadata: { fileName: file.name, sizeBytes: file.size, mimeType: file.mimeType },
        }),
      ),
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to register upload" }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { getWorkspaceContext, registerUploads } from "@/lib/server-documents";
import { createWorkspaceBucketPath } from "@/lib/supabase-server-adapter";

export async function POST(request: Request) {
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

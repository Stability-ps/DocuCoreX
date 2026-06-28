import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { registerUploads } from "@/lib/server-documents";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const files = Array.from(formData.entries())
      .filter(([key]) => key === "file")
      .map(([, value]) => value)
      .filter((value): value is File => value instanceof File)
      .map((file) => ({ name: file.name, size: file.size, type: file.type }));

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

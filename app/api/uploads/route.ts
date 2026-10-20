import { NextRequest, NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { recordAuditLog } from "@/lib/audit";
import { UserFacingError } from "@/lib/user-facing-error";
import { getWorkspaceContext, registerUploads, validateUploadFiles } from "@/lib/server-documents";
import { createWorkspaceBucketPath } from "@/lib/supabase-server-adapter";
import { enforceRateLimit } from "@/lib/shared-rate-limit";
import { isOwnDocumentsPath } from "@/lib/direct-upload";
import { SIGNATURE_HEAD_BYTES, checkFileSignature, readResponseHead } from "@/lib/file-signature";
import { scanBytes, scanStoredObject, scanningMode, uploadScanDecision, type UploadScanDecision } from "@/lib/malware-scan";

const MAX_UPLOAD_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB

// A signed upload of up to 200 MB may be scanned before it is registered.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit("upload", { request }, "Upload rate limit exceeded. Try again in a moment.");
  if (limited) return limited;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const uploadedFiles = Array.from(formData.entries())
      .filter(([key]) => key === "file")
      .map(([, value]) => value)
      .filter((value): value is File => value instanceof File);

    try {
      // Validate before anything reaches storage. registerUploads validates
      // again, but only after the loop below had already written every file —
      // a rejected .html or MIME-spoofed upload was refused with 400 yet left
      // its bytes in the bucket with no document row, invisible and never
      // cleaned up.
      validateUploadFiles(uploadedFiles.map((file) => ({ name: file.name, size: file.size, type: file.type })));
      // The name and declared type are the client's word. Check the bytes too,
      // before anything is written.
      for (const file of uploadedFiles) {
        const head = new Uint8Array(await file.slice(0, SIGNATURE_HEAD_BYTES).arrayBuffer());
        const signature = checkFileSignature(file.name, head);
        if (!signature.ok) throw new UserFacingError(signature.reason);
      }
      // Malware: scanned before anything is written, so an infected file is
      // never stored (lib/malware-scan.ts; off unless MALWARE_SCANNING=required).
      const scanMode = scanningMode();
      if (scanMode === "required") {
        for (const file of uploadedFiles) {
          const decision = uploadScanDecision(scanMode, file.name, await scanBytes(new Uint8Array(await file.arrayBuffer())));
          if (decision.action === "reject") {
            await recordScanRejection(file.name, decision);
            return NextResponse.json({ error: decision.message, code: decision.infected ? "MALWARE_DETECTED" : "SCAN_UNAVAILABLE" }, { status: decision.status });
          }
        }
      }
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
            // Storage's message stays in the log (routeErrorResponse below).
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
      // Validation messages (UserFacingError) are returned as they are; a
      // Storage or database failure is logged and answered generically.
      return routeErrorResponse("docucorex.upload.multipart_failed", error, { message: "Unable to upload the file. Please try again.", code: "UPLOAD_FAILED" });
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    files?: Array<{ name: string; size: number; type: string; storagePath?: string }>;
  };

  let files = body.files ?? [];

  // Registering objects already written to storage through a signed upload URL.
  // Nothing the client declares is trusted: each path must be in the caller's
  // own documents folder, and the size and type validated are the stored
  // object's. A stored object that fails validation is removed again.
  const context = await getWorkspaceContext().catch(() => null);
  if (context && files.some((file) => file.storagePath)) {
    const verified = [];
    for (const file of files) {
      if (!isOwnDocumentsPath(file.storagePath, context.workspaceId)) {
        return NextResponse.json({ error: `${file.name || "File"} was not uploaded to this workspace.` }, { status: 400 });
      }
      const folder = file.storagePath.slice(0, file.storagePath.lastIndexOf("/"));
      const objectName = file.storagePath.slice(folder.length + 1);
      const { data: listed, error: listError } = await context.supabase.storage
        .from("documents")
        .list(folder, { search: objectName, limit: 1 });
      const stored = listed?.find((entry) => entry.name === objectName);
      if (listError || !stored) {
        return NextResponse.json({ error: `${file.name || "File"} was not found in storage. Upload it again.` }, { status: 400 });
      }
      const metadata = (stored.metadata ?? {}) as { size?: number; mimetype?: string };
      const actual = { name: file.name, size: Number(metadata.size ?? 0), type: metadata.mimetype || file.type, storagePath: file.storagePath };
      try {
        validateUploadFiles([actual]);
      } catch (error) {
        await context.supabase.storage.from("documents").remove([file.storagePath]);
        return routeErrorResponse("docucorex.upload.validation_failed", error, { message: "Unsupported file.", status: 400, code: "UNSUPPORTED_FILE" });
      }
      // And the stored bytes, not just the stored metadata: a signed upload
      // accepts whatever the client sends. A file that cannot be read back is
      // refused too, rather than registered unchecked.
      const head = await readStoredHead(context.supabase, file.storagePath);
      const signature = head
        ? checkFileSignature(file.name, head)
        : { ok: false as const, reason: `${file.name || "File"} could not be verified. Upload it again.` };
      if (!signature.ok) {
        await context.supabase.storage.from("documents").remove([file.storagePath]);
        return NextResponse.json({ error: signature.reason }, { status: 400 });
      }
      // Malware: the object is already in storage (a signed upload), so the
      // scanner fetches it itself through a 60 s signed URL rather than this
      // function streaming up to 200 MB. Anything but "clean" removes it.
      const scanMode = scanningMode();
      if (scanMode === "required") {
        const { data: signed } = await context.supabase.storage.from("documents").createSignedUrl(file.storagePath, 60);
        const result = signed?.signedUrl ? await scanStoredObject(signed.signedUrl) : null;
        const decision = uploadScanDecision(scanMode, file.name || "File", result);
        if (decision.action === "reject") {
          await context.supabase.storage.from("documents").remove([file.storagePath]);
          await recordScanRejection(file.name || "File", decision);
          return NextResponse.json({ error: decision.message, code: decision.infected ? "MALWARE_DETECTED" : "SCAN_UNAVAILABLE" }, { status: decision.status });
        }
      }
      verified.push(actual);
    }
    files = verified;
  }

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
    return routeErrorResponse("docucorex.upload.register_failed", error, { message: "Unable to register the upload. Please try again.", code: "UPLOAD_FAILED" });
  }
}

type WorkspaceSupabase = NonNullable<Awaited<ReturnType<typeof getWorkspaceContext>>>["supabase"];

// The first bytes of a stored object, through a short-lived signed URL and a
// Range request, so a 200 MB upload is not downloaded to check 8 KB of it.
async function readStoredHead(supabase: WorkspaceSupabase, storagePath: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase.storage.from("documents").createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) return null;
  try {
    const response = await fetch(data.signedUrl, {
      headers: { Range: `bytes=0-${SIGNATURE_HEAD_BYTES - 1}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await readResponseHead(response);
  } catch {
    return null;
  }
}

// An infected file is recorded (name and signature only, never content) so the
// workspace's audit log shows what was blocked; an unavailable scanner is not.
async function recordScanRejection(fileName: string, decision: Extract<UploadScanDecision, { action: "reject" }>) {
  if (!decision.infected) {
    console.error("docucorex.malware_scan.unavailable", { status: decision.status });
    return;
  }
  console.warn("docucorex.malware_scan.blocked", { fileName, signature: decision.signature ?? null });
  await recordAuditLog({ action: "upload_blocked_malware", entityType: "upload", metadata: { fileName, signature: decision.signature ?? null } }).catch(() => undefined);
}

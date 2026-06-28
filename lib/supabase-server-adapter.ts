import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function createDocumentVersionRecord(documentId: string, storagePath: string, changeNote: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    return null;
  }

  const { data: versions } = await context.supabase
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersion = (versions?.version_number ?? 0) + 1;

  const { data, error } = await context.supabase
    .from("document_versions")
    .insert({
      document_id: documentId,
      version_number: nextVersion,
      storage_path: storagePath,
      change_note: changeNote,
      created_by: context.userId,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to create document version");
  }

  return data.id;
}

export async function saveProcessingJob(documentId: string, type: "ocr" | "extraction" | "conversion", status: string, progress: number, message: string) {
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from("processing_jobs")
    .insert({
      document_id: documentId,
      type,
      status,
      progress,
      message,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to persist processing job");
  }

  return data.id;
}

export async function createWorkspaceBucketPath(workspaceId: string, fileName: string) {
  return `${workspaceId}/documents/${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

// Downloads a document's stored bytes for OCR/extraction. Uses the service-role
// client so it works both on Vercel (in-process) and in the conversion worker.
// Never logs bytes or content.
//
// The service role bypasses storage RLS, so the path must be proved to belong to
// the document's own workspace first (lib/storage-paths.ts). Without that, a user
// who pointed their document's storage_path at another workspace's file had it
// OCR'd into their own results.
import { createSupabaseServiceRoleClient } from "@/lib/supabase-server";
import { assertWorkspaceStoragePath } from "@/lib/storage-paths";

export async function loadDocumentBytes(storagePath: string, workspaceId: string): Promise<Uint8Array | null> {
  if (!storagePath) return null;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  assertWorkspaceStoragePath(storagePath, workspaceId, { reader: "loadDocumentBytes" });
  const { data, error } = await supabase.storage.from("documents").download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

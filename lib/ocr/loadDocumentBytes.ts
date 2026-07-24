// Downloads a document's stored bytes for OCR/extraction. Uses the service-role
// client so it works both on Vercel (in-process) and in the conversion worker.
// Never logs bytes or content.
import { createSupabaseServiceRoleClient } from "@/lib/supabase-server";

export async function loadDocumentBytes(storagePath: string): Promise<Uint8Array | null> {
  if (!storagePath) return null;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from("documents").download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

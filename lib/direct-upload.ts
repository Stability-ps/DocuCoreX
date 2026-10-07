// Direct-to-storage uploads.
//
// Vercel functions accept at most ~4.5 MB of request body, so multipart
// POST /api/uploads could never take the 200 MB the app advertised: anything
// larger died at the platform with a raw 413 (release audit, 2026-10-07).
// Large files are therefore written straight to Supabase Storage through a
// signed upload URL (/api/uploads/signed-url, which validates name and type),
// then registered with POST /api/uploads (JSON). Registration must not trust
// the client: the path has to sit in the caller's own documents folder, and the
// size and type checked are the stored object's, read back from storage.

/** Files above this go direct to storage; below it the proven multipart path is kept. */
export const DIRECT_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024;

/**
 * True only for a single object directly inside `<workspaceId>/documents/` —
 * never another workspace, a sub-folder, or a traversal.
 */
export function isOwnDocumentsPath(storagePath: unknown, workspaceId: string): storagePath is string {
  if (typeof storagePath !== "string" || !workspaceId) return false;
  const prefix = `${workspaceId}/documents/`;
  if (!storagePath.startsWith(prefix)) return false;
  const name = storagePath.slice(prefix.length);
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..";
}

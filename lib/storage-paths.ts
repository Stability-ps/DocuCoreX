// Which stored objects a workspace's job may touch with privileged credentials.
//
// The service-role client bypasses storage RLS, so whatever path it is handed is
// read, whoever's it is. Paths come from rows a user can edit (documents,
// accounting_statement_runs), and until 053 nothing stopped a user pointing
// their own row at another workspace's object and having OCR, conversion or the
// accounting worker read it for them. Every privileged read now checks that the
// path sits inside the workspace the job belongs to.
//
// Mirrors the rule migration 053 enforces in the database, and the accounting
// worker's storage_path_belongs_to_workspace.

export function isWorkspaceStoragePath(path: unknown, workspaceId: string | null | undefined): path is string {
  if (typeof path !== "string" || !workspaceId) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.length < 2 || segments[0] !== workspaceId) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export class ForeignStoragePathError extends Error {
  constructor() {
    super("The document's stored file does not belong to its workspace.");
    this.name = "ForeignStoragePathError";
  }
}

/** Throws unless `path` is inside `workspaceId`'s folder. Logs ids only, never the path. */
export function assertWorkspaceStoragePath(path: unknown, workspaceId: string | null | undefined, context: Record<string, unknown> = {}): asserts path is string {
  if (isWorkspaceStoragePath(path, workspaceId)) return;
  console.error("docucorex.storage.foreign_path_refused", { workspaceId: workspaceId ?? null, ...context });
  throw new ForeignStoragePathError();
}

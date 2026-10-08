// Validation for POST /api/jobs/process bodies (pure; unit-tested).
//
// Every id is a UUID. conversionId in particular is interpolated into an ILIKE
// pattern (`%conversion:<id>%`) to find its job, so a "%" would have matched
// any conversion job in any workspace.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProcessJobRequest = {
  conversionId?: string;
  jobId?: string;
  documentId?: string;
};

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function validateProcessRequest(body: unknown): { ok: true; request: ProcessJobRequest } | { ok: false; error: string } {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const request: ProcessJobRequest = {};
  for (const key of ["conversionId", "jobId", "documentId"] as const) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    if (!isUuid(value)) return { ok: false, error: `${key} must be a valid id.` };
    request[key] = value;
  }
  return { ok: true, request };
}

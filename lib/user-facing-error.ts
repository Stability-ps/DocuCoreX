// An error whose message was written for the person using the app — a
// validation failure, a missing record, a file that cannot be accepted.
//
// Route catch-alls used to return `error.message` for anything thrown, which
// passed PostgREST, Storage and provider text (table and column names, object
// paths, hostnames) straight to the client. Throw this for messages that are
// meant to be read; everything else is treated as unexpected and replaced with a
// generic sentence (lib/api-errors.ts, lib/jobs/job-error.ts).
//
// Kept free of next/server so lib modules and unit tests can import it.

export class UserFacingError extends Error {
  // Plain fields rather than constructor parameter properties: node's
  // strip-only TypeScript loader used by the unit tests does not support them.
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "UserFacingError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "VALIDATION_ERROR";
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}

// Classifies accounting failures into what a person may read and what only the
// server log may hold.
//
// The accounting routes used to answer every catch with `error.message`, and
// most of what reached them was PostgREST text thrown on from these lib
// modules: table, column, constraint and RLS policy names. Throws written for
// people are now UserFacingErrors carrying the HTTP status they mean; database
// errors go through accountingDbError, which keeps only the posting rules the
// database itself words for the accountant (migrations 036+: unbalanced
// journal, closed period, completed reconciliation, over-allocation).
//
// Kept free of next/server so lib modules and unit tests can import it.

import { UserFacingError } from "@/lib/user-facing-error";

/** A record that is absent, or not in the caller's workspace (the two are not told apart). */
export function notFoundError(message: string) {
  return new UserFacingError(message, { status: 404, code: "NOT_FOUND" });
}

/** The caller is signed in but not allowed to do this. */
export function forbiddenError(message: string) {
  return new UserFacingError(message, { status: 403, code: "FORBIDDEN" });
}

/** A well-formed request an accounting rule refuses: closed period, unbalanced journal, disposed asset. */
export function businessRuleError(message: string) {
  return new UserFacingError(message, { status: 422, code: "BUSINESS_RULE" });
}

type DatabaseErrorLike = { message?: string | null; code?: string | null };

// SQLSTATEs as PostgREST reports them.
const RESTRICT_VIOLATION = "23001"; // `raise exception ... using errcode = 'restrict_violation'`
const UNIQUE_VIOLATION = "23505";
const NO_DATA_FOUND = "P0002"; // `using errcode = 'no_data_found'`
const INSUFFICIENT_PRIVILEGE = "42501"; // explicit access checks, and RLS refusals
const NO_SINGLE_ROW = "PGRST116"; // .single() matched no row (or several)

// restrict_violation is also raised by the append-only and write-path triggers,
// whose text names the table. Those only fire on an application bug, so they
// are treated as internal rather than shown.
const INTERNAL_RESTRICT_TEXT = /append-only|may only be written by/i;

/**
 * The Error to throw for a failed Supabase/PostgREST call in an accounting lib
 * module.
 *
 * - A posting rule the database words for people (restrict_violation) → 422,
 *   message unchanged.
 * - `<thing> <id> not found` from an accounting RPC (no_data_found) → 404,
 *   message unchanged; it echoes only the id the caller sent.
 * - `.single()` matching no row (PGRST116) → 404 with a fixed sentence: the
 *   update or read targeted a record outside the caller's workspace or gone.
 * - An access refusal (42501) → 403 with a fixed sentence: RLS refusals name
 *   the table.
 * - A unique violation → 409 with a fixed sentence: the text names the
 *   constraint and echoes the conflicting value.
 * - Anything else → a plain Error. Its message is the database text, which the
 *   route catch-all logs and replaces with a generic sentence.
 */
export function accountingDbError(error: DatabaseErrorLike): Error {
  const message = error.message ?? "Database request failed.";
  switch (error.code) {
    case RESTRICT_VIOLATION:
      return INTERNAL_RESTRICT_TEXT.test(message) ? new Error(message) : businessRuleError(message);
    case NO_DATA_FOUND:
      return notFoundError(message);
    case NO_SINGLE_ROW:
      return notFoundError("This record was not found.");
    case INSUFFICIENT_PRIVILEGE:
      return forbiddenError("You do not have access to this record.");
    case UNIQUE_VIOLATION:
      return new UserFacingError("This record already exists.", { status: 409, code: "DUPLICATE" });
    default:
      return new Error(message);
  }
}

/**
 * The text to report for one failed row of a bulk operation (CSV import,
 * depreciation run) whose overall response still succeeds. Deliberate messages
 * are kept; anything else is logged under `event` and replaced with `fallback`.
 */
export function rowFailureMessage(event: string, error: unknown, fallback: string, context: Record<string, unknown> = {}): string {
  if (error instanceof UserFacingError) return error.message;
  console.error(event, {
    ...context,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return fallback;
}

import { NextResponse } from "next/server";
import { isUnauthorizedError, unauthorizedResponse } from "@/lib/api-auth";
import { isUserFacingError } from "@/lib/user-facing-error";

type DatabaseErrorLike = { message?: string; code?: string; details?: string | null; hint?: string | null } | null | undefined;

/**
 * Responds to a failed Supabase/PostgREST/Storage call without handing the
 * client the raw error text.
 *
 * PostgREST messages name tables, columns, constraints and RLS policies, and
 * Storage messages can echo object paths — none of which a caller needs, and
 * all of which help someone mapping the schema. The detail goes to the server
 * log under `event`; the client gets a generic sentence and a stable `code`.
 */
export function databaseErrorResponse(
  event: string,
  error: DatabaseErrorLike,
  options: { message?: string; code?: string; status?: number; context?: Record<string, unknown> } = {},
) {
  console.error(event, {
    ...options.context,
    dbCode: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  });
  return NextResponse.json(
    { error: options.message ?? "Something went wrong. Please try again.", code: options.code ?? "DATABASE_ERROR" },
    { status: options.status ?? 500 },
  );
}

/**
 * Responds to an error caught by a route's catch-all.
 *
 * A missing session is a 401, and a UserFacingError is a deliberate message —
 * both go to the client as they are. Anything else is unexpected: most often a
 * database, storage or provider message thrown on from a lib module, so it is
 * logged under `event` and the client gets `message` and a stable code.
 */
export function routeErrorResponse(
  event: string,
  error: unknown,
  options: { message: string; code?: string; status?: number; context?: Record<string, unknown> },
) {
  if (isUnauthorizedError(error)) return unauthorizedResponse();
  if (isUserFacingError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error(event, {
    ...options.context,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json(
    { error: options.message, code: options.code ?? "INTERNAL_ERROR" },
    { status: options.status ?? 500 },
  );
}

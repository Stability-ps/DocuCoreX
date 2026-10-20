import { NextResponse } from "next/server";

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

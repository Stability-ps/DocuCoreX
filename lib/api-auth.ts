import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import { isUserFacingError } from "@/lib/user-facing-error";

// getWorkspaceContext() signals "configured backend, no valid session" by
// throwing Error("Unauthorized"). Routes that let that escape, or caught it
// into a blanket 500, answered an expired session with a server error — the
// client could not tell "sign in again" from "the server broke", and every
// signed-out poll showed up as a 500 in monitoring.

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message === "Unauthorized";
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "Your session has expired. Sign in again to continue." }, { status: 401 });
}

/**
 * A caught route error as a response.
 *
 * - A missing session → 401.
 * - A UserFacingError → its own message, status and code, unchanged: it was
 *   written for the person using the app (validation, not found, a refused
 *   posting rule).
 * - Anything else → `fallbackMessage` with `status` and code INTERNAL_ERROR.
 *   This used to return `error.message`, which handed PostgREST, Storage and
 *   worker text (table, column and constraint names, object paths, hosts) to
 *   the client. The detail is logged under `event` instead.
 */
export function errorResponse(error: unknown, fallbackMessage: string, status = 500, event = "docucorex.api.unexpected_error") {
  if (isUnauthorizedError(error)) return unauthorizedResponse();
  if (isUserFacingError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error(event, {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json({ error: fallbackMessage, code: "INTERNAL_ERROR" }, { status });
}

/**
 * getWorkspaceContext() for a route handler. A missing session becomes a 401
 * response, never null: in these routes null means demo mode (no Supabase
 * configured), and mapping a signed-out request onto it would serve the demo
 * store to a real deployment. Any other failure still throws.
 */
export async function resolveWorkspaceContext() {
  try {
    return await getWorkspaceContext();
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    throw error;
  }
}

/**
 * Wraps a route handler so a missing session thrown from anywhere inside it —
 * including helpers such as getDocumentWithJobs that resolve the context
 * themselves — becomes a 401 instead of an unhandled 500. Every other error
 * still propagates unchanged.
 */
export function withUnauthorized<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isUnauthorizedError(error)) return unauthorizedResponse();
      throw error;
    }
  };
}

import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/server-documents";

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

/** A caught route error as a response: 401 for a missing session, `status` otherwise. */
export function errorResponse(error: unknown, fallbackMessage: string, status = 500) {
  if (isUnauthorizedError(error)) return unauthorizedResponse();
  return NextResponse.json({ error: error instanceof Error ? error.message : fallbackMessage }, { status });
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

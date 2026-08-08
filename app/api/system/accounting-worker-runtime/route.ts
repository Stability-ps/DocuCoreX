// TEMPORARY (2026-08-06) — DELETE once the shared-secret mismatch is resolved.
//
// Reports what the RUNNING Preview runtime holds for ACCOUNTING_WORKER_TOKEN.
// The Vercel and Render dashboards both appear to show a token with SHA-256
// prefix 75e596d1b6be, yet the worker rejects that value — and after a Render
// restart it still does, so the stored-vs-running distinction is the only thing
// left to measure. A dashboard shows what was STORED; this shows what the
// process actually HOLDS.
//
// SECRET SAFETY. Returns presence, length and a full SHA-256 digest, and nothing
// else. Never the token, never a prefix or substring, never the Authorization
// header, and nothing about Azure, Supabase or any other credential. A full
// unsalted digest is an offline verification oracle for the value, which is
// acceptable only because this secret is ~256 bits of randomness.
//
// Authenticated: an unauthenticated caller could otherwise confirm a guessed
// token against the digest. On Preview this additionally sits behind Vercel SSO.
import { NextResponse } from "next/server";
import { buildRuntimeTokenReport } from "@/lib/accounting/workerAuthDiagnostics";
import { getWorkspaceContext } from "@/lib/server-documents";

// Must be evaluated per request in the Node runtime: node:crypto is unavailable
// on edge, and a statically-optimized handler could bake in a build-time value —
// which is exactly the stored-vs-running distinction this endpoint exists to
// measure.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(buildRuntimeTokenReport(), {
    headers: { "Cache-Control": "no-store" },
  });
}

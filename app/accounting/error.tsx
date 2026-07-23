"use client";

// Error boundary for the entire /accounting segment (the Accounting Intelligence
// dashboard AND the /accounting/statements/[id] workspace). Without this, any
// throw during render/effect — e.g. re-mounting the dashboard after pressing the
// browser Back button from a statement — bubbles to Next.js's root handler and
// shows the generic white-screen "Application error: a client-side exception".
//
// Here we (1) keep the crash non-fatal with a recoverable UI, (2) surface the
// REAL error (message + digest) on screen and in the console so the exact
// exception is identifiable in production, and (3) offer a graceful path back to
// the statements list instead of a dead end.
import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

export default function AccountingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged client-side so the exact exception + stack are visible in the
    // browser console even though the production overlay is minified.
    console.error("[accounting] client render error", { message: error.message, digest: error.digest, stack: error.stack });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <h1 className="text-lg font-semibold text-navy-950">Something went wrong loading this page</h1>
      <p className="max-w-md text-sm font-medium text-slate-500">
        The accounting workspace hit an unexpected error. Your statements are safe — try again, or go back to the list.
      </p>
      {error?.message ? (
        <p className="max-w-md break-words rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-600">
          {error.message}
          {error.digest ? ` (digest: ${error.digest})` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-royal-600 px-4 py-2 text-sm font-bold text-white hover:bg-royal-700"
        >
          Try again
        </button>
        <Link
          href="/accounting"
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
        >
          Back to statements
        </Link>
      </div>
    </div>
  );
}

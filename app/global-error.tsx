"use client";

// Root fallback error boundary. Catches errors that escape every nested
// error.tsx (including failures in the root layout). Next.js renders this in
// place of the whole document, so it MUST provide its own <html>/<body>.
// This is the last line of defence against the generic white-screen
// "Application error: a client-side exception has occurred".
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app] global client error", { message: error.message, digest: error.digest, stack: error.stack });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8fafc" }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>Something went wrong</h1>
          <p style={{ maxWidth: 480, fontSize: 14, color: "#64748b" }}>The application hit an unexpected error. Please try again.</p>
          {error?.message ? (
            <pre style={{ maxWidth: 480, overflow: "auto", background: "#f1f5f9", padding: "8px 12px", borderRadius: 8, fontSize: 12, color: "#475569" }}>
              {error.message}
              {error.digest ? ` (digest: ${error.digest})` : ""}
            </pre>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{ borderRadius: 8, background: "#006ee6", color: "#fff", border: "none", padding: "8px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >
              Try again
            </button>
            <a
              href="/accounting"
              style={{ borderRadius: 8, background: "#fff", color: "#334155", border: "1px solid #e2e8f0", padding: "8px 16px", fontSize: 14, fontWeight: 700, textDecoration: "none" }}
            >
              Back to statements
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}

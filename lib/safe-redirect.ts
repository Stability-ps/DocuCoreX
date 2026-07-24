// Guards against open-redirect abuse of a `next` query parameter. Only internal,
// single-slash-relative paths are honoured; anything that could escape the origin
// (absolute URLs, protocol-relative `//host`, backslash tricks, encoded slashes,
// or a scheme like `javascript:`) falls back to a safe internal default.
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (typeof next !== "string") return fallback;
  const value = next.trim();

  // Must be a root-relative path…
  if (!value.startsWith("/")) return fallback;
  // …but not protocol-relative (//host) or a backslash variant (/\\host).
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // No backslashes at all (browsers normalise \\ to /).
  if (value.includes("\\")) return fallback;
  // Reject encoded leading slashes/backslashes that browsers may re-normalise.
  if (/^\/%2f/i.test(value) || /^\/%5c/i.test(value)) return fallback;
  // Reject control characters (incl. newlines/tabs) used to smuggle a new URL.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  return value;
}

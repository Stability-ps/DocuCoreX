/**
 * Tag normalisation and validation.
 *
 * Pure and shared by the route and the UI so a tag cannot be accepted by one
 * and rejected by the other. Nothing here touches accounting treatment: a tag
 * is a business grouping, and the rules below are about text hygiene, not about
 * what a transaction means.
 */

export const MAX_TAG_LENGTH = 64;

export type TagRejection = "empty" | "too_long";

/**
 * Collapse whitespace and trim. Casing is preserved, because "Project Alpha"
 * is how the user wrote it and echoing it back lowercased looks like a bug —
 * uniqueness is handled case-insensitively instead, by the database index and
 * by `sameTag` below.
 */
export function normalizeTag(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function tagRejection(raw: string): TagRejection | null {
  const tag = normalizeTag(raw);
  if (!tag) return "empty";
  // Measured after normalisation: a value that only exceeds the limit because
  // of runs of spaces is not too long, it is untidy.
  if (tag.length > MAX_TAG_LENGTH) return "too_long";
  return null;
}

export function isValidTag(raw: string): boolean {
  return tagRejection(raw) === null;
}

/** Case-insensitive identity, matching the database's unique index. */
export function sameTag(a: string, b: string): boolean {
  return normalizeTag(a).toLowerCase() === normalizeTag(b).toLowerCase();
}

/**
 * De-duplicate a list case-insensitively, keeping the first spelling seen.
 *
 * Used when building the workspace vocabulary from stored rows: "Vehicle 2" and
 * "vehicle 2" are one tag, and the suggestion list should offer it once rather
 * than inviting the user to create the duplicate the index would then reject.
 */
export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Alphabetical, case-insensitive — a stable order for a picker. */
export function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

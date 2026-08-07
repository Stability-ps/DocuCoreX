import categoryData from "@/workers/accounting_worker/engine/categories.json" with { type: "json" };

/**
 * The accounting category vocabulary — the TypeScript view of the one canonical
 * file the Python worker reads.
 *
 * Four vocabularies had grown apart: what the worker stored (29 strings), what
 * the professional chart and the AI produced, what this dropdown offered (27),
 * and what AI validation accepted (33) — 46 distinct strings in total. Eleven
 * categories the worker wrote could not be selected here at all, nine options
 * here were produced by nothing, and the same account appeared under several
 * spellings.
 *
 * A reviewer cannot correct a category the dropdown does not contain, and a
 * correction made in one spelling trains a learned rule the other side does not
 * recognise. So both languages now read the same file. It lives in the worker
 * package because the worker deploys from there and must have it at runtime.
 */

type CategoryEntry = { id: string; label: string; aliases: string[] };

const ENTRIES: CategoryEntry[] = (categoryData.categories as CategoryEntry[]).map((entry) => ({
  id: entry.id,
  label: entry.label,
  aliases: entry.aliases ?? [],
}));

/** Every category that may be stored, in presentation order. */
export const CANONICAL_CATEGORIES: string[] = ENTRIES.map((entry) => entry.id);

/** What a reviewer picks from: the stored value plus the label they read. */
export const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = ENTRIES.map((entry) => ({
  value: entry.id,
  label: entry.label,
}));

const ALIAS_INDEX = new Map<string, string>();
for (const entry of ENTRIES) {
  ALIAS_INDEX.set(normalise(entry.id), entry.id);
  for (const alias of entry.aliases) ALIAS_INDEX.set(normalise(alias), entry.id);
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Map any known spelling to its canonical id, or null if unrecognised.
 *
 * Null rather than a guess: an unrecognised category is worth surfacing, and
 * silently coercing it to Uncategorised would hide a real inconsistency.
 */
export function canonicaliseCategory(value: string | null | undefined): string | null {
  if (!value) return null;
  return ALIAS_INDEX.get(normalise(value)) ?? null;
}

export function isKnownCategory(value: string | null | undefined): boolean {
  return canonicaliseCategory(value) !== null;
}

/**
 * What to show for a stored value — including one written before unification.
 * An unrecognised value is shown as-is rather than hidden: the reviewer should
 * see what the row actually holds.
 */
/**
 * The options to offer for a row currently holding `value`.
 *
 * A row written before unification may hold a historical spelling. It is
 * prepended rather than dropped, so the dropdown always shows what the row
 * actually holds — a `<select>` whose value is absent from its options renders
 * blank, which would misrepresent the row as unclassified and invite a
 * correction the reviewer never meant to make.
 */
export function categoryOptionsFor(value: string | null | undefined): Array<{ value: string; label: string }> {
  if (!value || CANONICAL_CATEGORIES.includes(value)) return CATEGORY_OPTIONS;
  const canonical = canonicaliseCategory(value);
  const label = canonical
    ? `${categoryLabel(value)} (was: ${value})`
    : `${value} (unrecognised)`;
  return [{ value, label }, ...CATEGORY_OPTIONS];
}

export function categoryLabel(value: string | null | undefined): string {
  if (!value) return "Uncategorised";
  const canonical = canonicaliseCategory(value);
  if (!canonical) return value;
  return ENTRIES.find((entry) => entry.id === canonical)?.label ?? canonical;
}

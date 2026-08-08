import policy from "@/workers/accounting_worker/engine/merchant_key_policy.json" with { type: "json" };

/**
 * Whether a normalised string is specific enough to become a workspace learned
 * rule — the TypeScript view of the policy the Python worker enforces, reading
 * the same file so creation and application cannot drift apart.
 *
 * A learned rule is applied to every future transaction in its workspace, so an
 * insufficiently specific key is not a small mistake. In production the key "d"
 * — normalised from the alias "mr d" of the seeded merchant "Mr D Food" —
 * matched 425 of 615 rows on a real 37-page statement and booked them all to
 * Meals & Groceries, including OVERDRAFT SERVICE FEE.
 *
 * This guards creation. Boundary-aware matching guards application. Both are
 * needed: a safe key applied as a raw substring is still wrong, and a boundary
 * match on "d" would still match the word "d".
 */

const STOPLIST = new Set<string>(policy.stoplist as string[]);
const MIN_LENGTH = policy.minLength as number;
const MIN_ALPHA_TOKEN_LENGTH = policy.minAlphaTokenLength as number;

/**
 * Why this key may not become a learned rule, or null if it may.
 *
 * The reason is returned rather than a boolean so a refusal can be explained —
 * to a user at creation, and in the logs when an already-stored rule is skipped.
 */
export function merchantKeyRejection(key: string | null | undefined): string | null {
  const text = (key ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!text) return "empty";
  if (text.length < MIN_LENGTH) return `too_short:${text.length}<${MIN_LENGTH}`;

  const tokens = text.split(/[^a-z0-9#*]+/).filter(Boolean);
  if (!tokens.length) return "no_usable_tokens";

  // Every token being generic or a payment-channel word means the key describes
  // a mechanism, not a counterparty: "card purchase", "payment to".
  if (tokens.every((token) => STOPLIST.has(token))) return `all_generic:${tokens.join(",")}`;

  // At least one token has to be substantial enough to name someone. "mr d food"
  // is carried by "food"; "mr d" is carried by nothing.
  const substantial = tokens.filter(
    (token) => token.length >= MIN_ALPHA_TOKEN_LENGTH && !STOPLIST.has(token) && !/^\d+$/.test(token),
  );
  if (!substantial.length) return `no_substantial_token:${tokens.join(",")}`;

  return null;
}

export function isSafeMerchantKey(key: string | null | undefined): boolean {
  return merchantKeyRejection(key) === null;
}

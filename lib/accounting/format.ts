/**
 * Money, count and date formatting for the accounting UI.
 *
 * One place decides, because the alternative was fourteen. Before this module
 * the currency symbol "R" and the locale "en-ZA" were written inline across
 * five components, which made the product structurally South African: shipping
 * to another market meant finding every one of them.
 *
 * ── On the currency actually being right ──────────────────────────────────
 *
 * `accounting_statement_runs` has no currency column, and the worker does not
 * extract one, so a statement's true currency is NOT available today. This
 * module therefore takes a currency code and falls back to a named default
 * rather than pretending to know. When statement-level detection exists, the
 * callers pass it and nothing here changes.
 *
 * The fallback is a stated assumption, not a hidden one — see
 * DEFAULT_STATEMENT_CURRENCY below.
 *
 * ── On locale and hydration ───────────────────────────────────────────────
 *
 * Grouping uses a FIXED locale rather than the viewer's. `Intl` with an
 * undefined locale resolves differently on the server and in the browser, and
 * Next.js renders both: the server would emit one string and the client
 * another, producing a hydration mismatch on every amount on the page.
 *
 * A fixed locale also keeps "1,234.56" stable for a reader comparing the screen
 * against a printed statement, which is what this data is for.
 */

const GROUPING_LOCALE = "en-GB";

/**
 * Used when no currency is known.
 *
 * Named and exported so it reads as the assumption it is. It is not a claim
 * about the customer — it is the value the existing data was written under, and
 * changing it silently would relabel every historical figure in the product.
 */
export const DEFAULT_STATEMENT_CURRENCY = "ZAR";

/**
 * Symbols for the currencies this UI has been checked against.
 *
 * A code with no entry falls back to the code itself ("SEK 1,234.56"), which is
 * unambiguous and correct — better than guessing a glyph, and better than
 * dropping the currency entirely.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  ZAR: "R",
  USD: "$",
  GBP: "£",
  EUR: "€",
  AUD: "A$",
  NZD: "NZ$",
  CAD: "C$",
  NGN: "₦",
  KES: "KSh",
  INR: "₹",
  JPY: "¥",
};

export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency || DEFAULT_STATEMENT_CURRENCY).toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? code;
}

/** Whether the symbol is a glyph (prefixes tightly) or a code (needs a space). */
function joinSymbol(symbol: string, amount: string): string {
  return /^[A-Z]{2,}$/.test(symbol) ? `${symbol} ${amount}` : `${symbol}${amount}`;
}

export function formatMoney(
  value: number | null | undefined,
  currency?: string | null,
  options: { decimals?: number; absolute?: boolean } = {},
): string {
  const decimals = options.decimals ?? 2;
  const raw = value ?? 0;
  const amount = options.absolute ? Math.abs(raw) : raw;

  const formatted = new Intl.NumberFormat(GROUPING_LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(amount));

  const symbol = currencySymbol(currency);
  // The minus leads the whole figure — "-R1,234.56", not "R-1,234.56" — which
  // is how a statement prints an overdrawn balance.
  return `${amount < 0 ? "-" : ""}${joinSymbol(symbol, formatted)}`;
}

export function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat(GROUPING_LOCALE).format(value ?? 0);
}

/**
 * A statement date, in a form that reads the same everywhere.
 *
 * "30 Apr 2025" rather than a numeric form: 04/05/2025 is the fourth of May in
 * London and the fifth of April in New York, and a bank statement is exactly
 * the document where that ambiguity is expensive. Canonical database dates are
 * untouched — this is presentation only.
 */
export function formatStatementDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function formatStatementDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * A masked account number for display: "•••• 8145".
 *
 * Country-neutral by construction — it shows the last four characters of
 * whatever the bank printed, whether that is a South African account number, a
 * UK sort-code-and-account, or a US routing/account pair.
 */
export function maskAccountNumber(accountNumber: string | null | undefined): string | null {
  const digits = (accountNumber ?? "").replace(/\s+/g, "");
  if (digits.length < 4) return digits || null;
  return `•••• ${digits.slice(-4)}`;
}

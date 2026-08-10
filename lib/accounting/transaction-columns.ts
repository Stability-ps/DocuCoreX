/**
 * Which transaction columns an accountant wants to see, and where that choice
 * lives.
 *
 * This is a view preference, not accounting data: it changes nothing about what
 * was extracted, classified or exported. It is stored per browser rather than
 * per user row because `user_settings` has a fixed column set with no JSONB
 * field, and adding a migration to record a table layout would be a schema
 * change in service of a cosmetic choice. When a settings blob exists, this
 * module is the single place that has to change.
 *
 * Date, Description and the two money columns are not optional. A statement
 * line with no date, no narrative and no amount is not a transaction the reader
 * can identify, and a "hide everything" state would look like data loss rather
 * than a display choice.
 */

export type TransactionColumnId =
  | "date"
  | "description"
  | "credit"
  | "debit"
  | "balance"
  | "category"
  | "gl"
  | "vat"
  | "status"
  | "sourcePage";

export type TransactionColumn = {
  id: TransactionColumnId;
  label: string;
  /** Locked columns cannot be hidden — without them a row is unidentifiable. */
  locked?: boolean;
  align?: "right";
};

export const TRANSACTION_COLUMNS: TransactionColumn[] = [
  { id: "date", label: "Date", locked: true },
  { id: "description", label: "Description", locked: true },
  { id: "credit", label: "Money In", locked: true, align: "right" },
  { id: "debit", label: "Money Out", locked: true, align: "right" },
  { id: "balance", label: "Balance", align: "right" },
  { id: "category", label: "Category" },
  { id: "gl", label: "GL" },
  { id: "vat", label: "VAT" },
  { id: "status", label: "Status" },
  { id: "sourcePage", label: "Source Page" },
];

/** Matches what the table rendered before columns became configurable, so an
 *  accountant who never opens the picker sees no change. `sourcePage` is the
 *  one addition and stays off by default. */
export const DEFAULT_VISIBLE_COLUMNS: TransactionColumnId[] = [
  "date",
  "description",
  "credit",
  "debit",
  "balance",
  "category",
  "gl",
  "vat",
  "status",
];

const STORAGE_KEY = "docucorex.accounting.transactionColumns.v1";

const LOCKED_IDS = TRANSACTION_COLUMNS.filter((c) => c.locked).map((c) => c.id);
const KNOWN_IDS = new Set<string>(TRANSACTION_COLUMNS.map((c) => c.id));

/**
 * Reconcile a stored selection with the columns that exist today.
 *
 * Unknown ids are dropped rather than trusted: a preference saved by an older
 * build must not resurrect a column that no longer has a renderer. Locked ids
 * are re-added rather than assumed present, so a hand-edited or truncated value
 * cannot produce a table with no identifying columns.
 */
export function normalizeVisibleColumns(stored: unknown): TransactionColumnId[] {
  const requested = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : null;
  if (!requested) return [...DEFAULT_VISIBLE_COLUMNS];

  const chosen = new Set(requested.filter((id) => KNOWN_IDS.has(id)));
  for (const locked of LOCKED_IDS) chosen.add(locked);

  // Preserve the canonical column order, not the order they were stored in —
  // a reordering feature would be a different, deliberate change.
  return TRANSACTION_COLUMNS.filter((column) => chosen.has(column.id)).map((column) => column.id);
}

export function loadVisibleColumns(): TransactionColumnId[] {
  if (typeof window === "undefined") return [...DEFAULT_VISIBLE_COLUMNS];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeVisibleColumns(raw ? JSON.parse(raw) : null);
  } catch {
    // Corrupt or unavailable storage (private mode, quota, bad JSON) must not
    // stop an accountant seeing their transactions.
    return [...DEFAULT_VISIBLE_COLUMNS];
  }
}

export function saveVisibleColumns(ids: TransactionColumnId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeVisibleColumns(ids)));
  } catch {
    // A preference that cannot be persisted still applies for this session.
  }
}

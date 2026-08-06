// Resolve what each column of a table MEANS from its header label.
//
// Semantic, never positional: column order varies between banks and between
// pages of one statement, so an index-based mapping silently mis-reads the first
// statement whose layout differs. A label that matches nothing stays "unknown"
// rather than being guessed into a role — a wrong role puts a balance in the
// amount column, which reconciles to nonsense.
import type { ColumnRole, StructuredCell } from "@/lib/pdf/types";

// Ordered: the first pattern that matches wins, so the more specific patterns
// come first. "closing balance" must beat the bare "balance" rule only in the
// sense that both mean balance — but "balance brought forward" must NOT be read
// as a date merely because it contains no digits.
const ROLE_PATTERNS: Array<{ role: ColumnRole; test: RegExp }> = [
  // Balance before amount: "balance" frequently co-occurs with currency words.
  { role: "balance", test: /\bbalance\b|\bbal\b|\bsaldo\b/i },
  { role: "date", test: /\bdate\b|\bdatum\b|^\s*d\/?t\s*$/i },
  { role: "description", test: /\bdescription\b|\bdetails?\b|\bnarrative\b|\btransaction\b|\bparticulars?\b|\bbeskrywing\b/i },
  { role: "debit", test: /\bdebits?\b|\bwithdrawals?\b|\bpayments? out\b|\bmoney out\b|\bdr\b/i },
  { role: "credit", test: /\bcredits?\b|\bdeposits?\b|\bpayments? in\b|\bmoney in\b|\bcr\b/i },
  { role: "reference", test: /\breference\b|\bref\b|\bcheque\b|\bcheck no\b|\bnumber\b/i },
  // Amount last: it is the least specific money word, so a column labelled
  // "Debit Amount" resolves as debit rather than as a signed amount.
  { role: "amount", test: /\bamount\b|\bvalue\b|\bbedrag\b/i },
];

/** Normalize a header label for matching: collapse whitespace, strip punctuation. */
export function normalizeLabel(label: string): string {
  return String(label ?? "")
    .replace(/[()\[\]:.,;*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a single header label to a role. Unmatched labels are "unknown". */
export function roleForLabel(label: string): ColumnRole {
  const normalized = normalizeLabel(label);
  if (!normalized) return "unknown";
  for (const { role, test } of ROLE_PATTERNS) {
    if (test.test(normalized)) return role;
  }
  return "unknown";
}

/**
 * Build the column → role map for a table from its `columnHeader` cells.
 *
 * Uses the cells Azure marked as headers rather than "row 0", because a
 * statement whose first row is a title banner would otherwise map every column
 * from one merged cell. When Azure marks no header cells at all, falls back to
 * row 0 — a table with data in row 0 then resolves mostly "unknown", which is
 * the safe direction.
 */
export function resolveColumnRoles(
  cells: StructuredCell[],
  columnCount: number,
): Array<{ index: number; label: string; role: ColumnRole }> {
  const headerCells = cells.filter((c) => c.kind === "columnHeader");
  const source = headerCells.length ? headerCells : cells.filter((c) => c.rowIndex === 0);

  // A header stacked over two rows ("Transaction" above "Date", "Debit" above
  // "Amount") is ONE label split by layout. Resolving each row separately and
  // picking a winner gets it backwards — "Transaction" alone reads as a
  // description, "Amount" alone loses the debit sign. Join the rows in order and
  // resolve the combined label once, which is how a person reads the column.
  const parts = new Map<number, Array<{ rowIndex: number; text: string }>>();
  for (const cell of source) {
    if (cell.columnIndex < 0) continue;
    const text = normalizeLabel(cell.content);
    if (!text) continue;
    const list = parts.get(cell.columnIndex) ?? [];
    list.push({ rowIndex: cell.rowIndex, text });
    parts.set(cell.columnIndex, list);
  }

  const headers: Array<{ index: number; label: string; role: ColumnRole }> = [];
  for (let index = 0; index < columnCount; index += 1) {
    const label = (parts.get(index) ?? [])
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .map((p) => p.text)
      .join(" ")
      .trim();
    headers.push({ index, label, role: roleForLabel(label) });
  }
  return headers;
}

/** Roles that carry a monetary value. */
export const MONEY_ROLES: ColumnRole[] = ["debit", "credit", "amount", "balance"];

/**
 * Is this the transaction table?
 *
 * Requires a date column AND at least one money column. A statement contains
 * several tables — account summary, fee schedules, a totals block — and only
 * this combination identifies the transaction ledger. Deliberately strict: a
 * false positive here feeds the wrong table into row building.
 */
export function isTransactionTable(headers: Array<{ role: ColumnRole }>): boolean {
  const roles = new Set(headers.map((h) => h.role));
  return roles.has("date") && MONEY_ROLES.some((role) => roles.has(role));
}

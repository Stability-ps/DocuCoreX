/**
 * Bulk journal import: grouping CSV rows into journals, and validating each
 * group as one accounting unit.
 *
 * No server imports — the browser and the tests both use this. Reference
 * lookups (does this account code exist, has this reference already been
 * imported) are passed in as plain maps/sets rather than fetched, so the
 * same function runs identically at preview and at commit.
 *
 * GROUP-LEVEL, NOT ROW-LEVEL — unlike the chart-of-accounts import. A
 * journal is one accounting unit: if row 8 of a 12-row journal names an
 * unknown account, all 12 rows are rejected together, never just the one.
 * Importing 11 of 12 lines would turn a balanced journal into an unbalanced
 * fragment, which is a worse outcome than rejecting it outright.
 *
 * The balance check below is the same arithmetic as journals.ts's
 * validateJournalLines, inlined rather than imported — every pure module in
 * lib/accounting is self-contained at runtime, so if that rule ever changes,
 * this file needs the same change made twice. It is still only guidance
 * either way: accounting_post_journal (036) is the actual control, and a
 * journal this file calls valid still goes through that gate before it posts.
 */

// Type-only, deliberately: every pure lib/accounting module in this codebase
// is self-contained at runtime — none of them calls a function defined in
// another one. A type import is erased before either tsc or `node --test`
// (used by tests/accounting/*.test.ts) ever has to resolve it; a real
// cross-file function import would need Next.js's @/ path alias, which only
// exists at the TypeScript/webpack build layer and isn't visible to plain
// Node — so the balance rule below is inlined rather than imported.
import type { JournalType } from "@/lib/accounting/journals";

const JOURNAL_TYPES: JournalType[] = [
  "general", "adjustment", "opening_balance", "depreciation", "disposal", "accrual", "prepayment", "tax", "closing", "reversal",
];

export type JournalImportRow = {
  rowNumber: number;
  reference: string;
  journalDate: string;
  description: string | null;
  dueDate: string | null;
  /** Blank means "general" — most imported history is ordinary journals, not opening balances or reversals. */
  journalType: string | null;
  accountCode: string;
  debit: number;
  credit: number;
  taxCode: string | null;
  customerName: string | null;
  supplierName: string | null;
};

export function readJournalImportRow(rowNumber: number, cells: Record<string, string>): JournalImportRow {
  const blank = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  const number = (value: string | undefined) => {
    const parsed = Number.parseFloat((value ?? "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    rowNumber,
    reference: (cells.reference ?? cells.journal_reference ?? "").trim(),
    journalDate: (cells.journal_date ?? cells.date ?? "").trim(),
    description: blank(cells.description),
    dueDate: blank(cells.due_date),
    journalType: blank(cells.journal_type ?? cells.type)?.toLowerCase() ?? null,
    accountCode: (cells.account_code ?? cells.code ?? "").trim(),
    debit: number(cells.debit),
    credit: number(cells.credit),
    taxCode: blank(cells.tax_code),
    customerName: blank(cells.customer ?? cells.customer_name),
    supplierName: blank(cells.supplier ?? cells.supplier_name),
  };
}

export type JournalImportGroup = { reference: string; rowNumbers: number[]; rows: JournalImportRow[] };

/** Groups by reference, case/whitespace-insensitively, preserving file order. */
export function groupJournalImportRows(rows: JournalImportRow[]): JournalImportGroup[] {
  const groups = new Map<string, JournalImportRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.reference.trim().toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }
  return order.map((key) => {
    const groupRows = groups.get(key)!;
    return { reference: groupRows[0].reference, rowNumbers: groupRows.map((r) => r.rowNumber), rows: groupRows };
  });
}

export type JournalImportOutcome =
  | {
      reference: string;
      rowNumbers: number[];
      status: "valid";
      journalDate: string;
      journalType: JournalType;
      description: string | null;
      dueDate: string | null;
      lines: Array<Pick<JournalImportRow, "accountCode" | "debit" | "credit" | "taxCode" | "customerName" | "supplierName">>;
    }
  | { reference: string; rowNumbers: number[]; status: "error"; messages: string[] };

export type JournalImportContext = {
  accountCodes: Set<string>;
  taxCodes: Set<string>;
  customerNames: Set<string>;
  supplierNames: Set<string>;
  /** References already imported for this entity in an earlier batch — lower-cased, trimmed. */
  alreadyImportedReferences: Set<string>;
};

const key = (value: string) => value.trim().toLowerCase();

/** Cents, as an integer, so summing never accumulates binary-float error — same rule as journals.ts's own cents(). */
function cents(value: number): number {
  return Math.round(value * 100);
}

function validateGroup(group: JournalImportGroup, ctx: JournalImportContext): JournalImportOutcome {
  const messages: string[] = [];

  if (!group.reference.trim()) {
    return { reference: group.reference, rowNumbers: group.rowNumbers, status: "error", messages: ["Missing journal reference."] };
  }
  if (ctx.alreadyImportedReferences.has(key(group.reference))) {
    messages.push(`Reference "${group.reference}" has already been imported for this entity — re-importing it would duplicate a posted journal.`);
  }

  const dates = new Set(group.rows.map((r) => r.journalDate).filter(Boolean));
  if (dates.size === 0) messages.push("No journal_date given.");
  if (dates.size > 1) messages.push(`This journal's rows disagree on journal_date: ${[...dates].join(", ")}.`);

  const dueDates = new Set(group.rows.map((r) => r.dueDate).filter((d): d is string => Boolean(d)));
  if (dueDates.size > 1) messages.push(`This journal's rows disagree on due_date: ${[...dueDates].join(", ")}.`);

  const types = new Set(group.rows.map((r) => r.journalType).filter((t): t is string => Boolean(t)));
  if (types.size > 1) messages.push(`This journal's rows disagree on journal_type: ${[...types].join(", ")}.`);
  const journalType = types.size ? [...types][0] : "general";
  if (!JOURNAL_TYPES.includes(journalType as JournalType)) {
    messages.push(`"${journalType}" is not a recognised journal type.`);
  }

  for (const row of group.rows) {
    if (!row.accountCode) {
      messages.push(`Row ${row.rowNumber}: missing account code.`);
    } else if (!ctx.accountCodes.has(key(row.accountCode))) {
      messages.push(`Row ${row.rowNumber}: account code "${row.accountCode}" does not exist in this entity's chart.`);
    }
    if (row.taxCode && !ctx.taxCodes.has(key(row.taxCode))) {
      messages.push(`Row ${row.rowNumber}: tax code "${row.taxCode}" does not exist.`);
    }
    if (row.customerName && !ctx.customerNames.has(key(row.customerName))) {
      messages.push(`Row ${row.rowNumber}: customer "${row.customerName}" does not exist.`);
    }
    if (row.supplierName && !ctx.supplierNames.has(key(row.supplierName))) {
      messages.push(`Row ${row.rowNumber}: supplier "${row.supplierName}" does not exist.`);
    }
    if (row.debit < 0 || row.credit < 0) {
      messages.push(`Row ${row.rowNumber}: amounts are magnitudes; use the other column instead of a negative.`);
    }
    const hasDebit = cents(row.debit) > 0;
    const hasCredit = cents(row.credit) > 0;
    if (hasDebit && hasCredit) messages.push(`Row ${row.rowNumber}: a line is either a debit or a credit, not both.`);
    if (!hasDebit && !hasCredit) messages.push(`Row ${row.rowNumber}: enter a debit or a credit.`);
  }

  // The same rule accounting_post_journal itself enforces (036), evaluated
  // here only so a malformed file is rejected before any journal in it is
  // ever built — this is guidance, not the control. If this and the
  // database ever disagree, the database is right and this is the bug.
  const debitTotal = group.rows.reduce((total, r) => total + cents(r.debit), 0);
  const creditTotal = group.rows.reduce((total, r) => total + cents(r.credit), 0);
  if (debitTotal !== creditTotal) {
    const difference = Math.abs(debitTotal - creditTotal) / 100;
    messages.push(`Journal does not balance: debits ${(debitTotal / 100).toFixed(2)}, credits ${(creditTotal / 100).toFixed(2)}, difference ${difference.toFixed(2)}.`);
  } else if (debitTotal === 0) {
    messages.push("A journal of zero cannot be posted.");
  }

  if (messages.length) {
    return { reference: group.reference, rowNumbers: group.rowNumbers, status: "error", messages };
  }

  return {
    reference: group.reference,
    rowNumbers: group.rowNumbers,
    status: "valid",
    journalDate: [...dates][0],
    journalType: journalType as JournalType,
    description: group.rows.find((r) => r.description)?.description ?? null,
    dueDate: dueDates.size ? [...dueDates][0] : null,
    lines: group.rows.map((r) => ({ accountCode: r.accountCode, debit: r.debit, credit: r.credit, taxCode: r.taxCode, customerName: r.customerName, supplierName: r.supplierName })),
  };
}

export function validateJournalImportRows(rows: JournalImportRow[], ctx: JournalImportContext): JournalImportOutcome[] {
  return groupJournalImportRows(rows).map((group) => validateGroup(group, ctx));
}

export function summariseJournalOutcomes(outcomes: JournalImportOutcome[]) {
  return {
    totalGroups: outcomes.length,
    validGroups: outcomes.filter((o) => o.status === "valid").length,
    rejectedGroups: outcomes.filter((o) => o.status === "error").length,
  };
}

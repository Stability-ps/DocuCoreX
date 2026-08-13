/**
 * General Ledger and Trial Balance types, and the formatting the reports share.
 *
 * No server imports — a client component and the tests both use this.
 *
 * The accounting rule this whole module serves: every figure here comes from
 * accounting_postings. Not from a bank statement's categories, not from a
 * transaction's account_category, not from an extraction. Those explain where a
 * number came from; postings are the books.
 */

export type LedgerRow = {
  postingId: string;
  postingDate: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  normalBalance: "debit" | "credit";
  journalId: string;
  journalReference: string | null;
  journalType: string;
  description: string | null;
  sourceTransactionId: string | null;
  /** The statement run the source transaction belongs to, for drill-down. */
  sourceRunId: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
};

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: "debit" | "credit";
  debits: number;
  credits: number;
  closingBalance: number;
  postingCount: number;
};

export type TrialBalanceTotals = {
  totalDebits: number;
  totalCredits: number;
  difference: number;
  balanced: boolean;
};

/**
 * Totals for a trial balance, summed in CENTS.
 *
 * Not a convenience: a trial balance is only meaningful if "balanced" means
 * exactly balanced. Summing floats would let a difference of 5.6e-17 render as
 * 0.00 and be declared balanced, or — worse — let a real one-cent error hide
 * inside the same rounding. The database stores numeric(18,2); this keeps the
 * arithmetic exact on the way to the screen.
 */
export function trialBalanceTotals(rows: TrialBalanceRow[]): TrialBalanceTotals {
  const debits = rows.reduce((total, row) => total + Math.round(row.debits * 100), 0);
  const credits = rows.reduce((total, row) => total + Math.round(row.credits * 100), 0);
  return {
    totalDebits: debits / 100,
    totalCredits: credits / 100,
    difference: (debits - credits) / 100,
    balanced: debits === credits,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03-08" → "8 Mar 2026". ISO is what is stored; this is presentation. */
export function formatLedgerDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name} ${year}` : iso;
}

export const JOURNAL_TYPE_LABELS: Record<string, string> = {
  general: "General",
  adjustment: "Adjustment",
  opening_balance: "Opening Balance",
  depreciation: "Depreciation",
  accrual: "Accrual",
  prepayment: "Prepayment",
  tax: "Tax",
  closing: "Closing",
  reversal: "Reversal",
};

/**
 * CSV for a ledger or trial balance export.
 *
 * Values are quoted and internal quotes doubled — an account named
 * `Consulting, "special"` must not become three columns. Amounts are written
 * unformatted so a spreadsheet reads them as numbers rather than as text.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (value: string | number | null) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return String(value);
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [headers.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n");
}

/**
 * The financial year containing `today`, for an entity closing on month/day.
 *
 * Lives here rather than in the component that uses it because it is pure date
 * arithmetic with a real accounting rule inside: a South African company
 * closing 28 February does not report January to December, so no report may
 * default to the calendar year.
 */
export function financialYearFor(endMonth: number, endDay: number, today: Date): { from: string; to: string } {
  const iso = (year: number, month: number, day: number) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const year = today.getUTCFullYear();
  const endThisYear = Date.UTC(year, endMonth - 1, endDay);
  // If the year-end has already passed this calendar year, the current period
  // ends next year; otherwise it ends this year.
  const endYear = today.getTime() > endThisYear ? year + 1 : year;

  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));
  const start = new Date(end.getTime());
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);

  return {
    from: iso(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()),
    to: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()),
  };
}

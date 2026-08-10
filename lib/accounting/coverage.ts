/**
 * Statement coverage: which account-months are actually in hand.
 *
 * The question an accountant has to answer before signing anything is not "are
 * these statements correct" but "are these all the statements". A missing month
 * is invisible in every other view in this product — the transactions that
 * would have been in it simply are not there, and nothing looks wrong.
 *
 * The discipline this module exists to enforce: a gap can only be called
 * MISSING when something establishes that a statement should exist. Two
 * situations are quite different, and conflating them produces confident
 * nonsense:
 *
 *   - Interior gap. April and June are present, May is not. May is provably
 *     missing: the account existed either side of it, so a statement exists.
 *
 *   - Exterior gap. The earliest statement is April. Is March missing? Only if
 *     the engagement began before April. Without a stated engagement, March is
 *     unknown — the account may have been opened in April, or the engagement may
 *     have started then. Reporting it as missing invents an obligation.
 *
 * So exterior months are only ever reported against an explicitly configured
 * engagement, never against boundaries inferred from the data itself.
 */

export type CoverageStatus =
  /** A statement is present and its closing balance reconciles. */
  | "reconciled"
  /** A statement is present but does not reconcile. */
  | "present"
  /** Transactions exist but there is no closing balance to reconcile against. */
  | "transactions_only"
  /** No statement for this account-month. */
  | "missing";

export type CoverageStatement = {
  accountLabel: string;
  /** YYYY-MM derived from the statement period end. */
  month: string;
  reconciled: boolean;
  hasClosingBalance: boolean;
  transactionCount: number;
};

export type Engagement = {
  /** YYYY-MM inclusive. */
  startMonth: string | null;
  endMonth: string | null;
  /** Accounts the engagement expects, beyond those already seen. */
  expectedAccounts: string[];
};

export type CoverageCell = { month: string; status: CoverageStatus };
export type CoverageRow = { accountLabel: string; cells: CoverageCell[] };

export type CoverageResult = {
  months: string[];
  rows: CoverageRow[];
  /** Present account-months as a percentage of those expected. */
  coveragePercent: number;
  missing: Array<{ accountLabel: string; month: string }>;
  accountsTracked: number;
  statementsReceived: number;
  statementsReconciled: number;
  /**
   * True when the reporting window came from the statements themselves rather
   * than from a configured engagement. In that case only interior gaps are
   * reported, and the caller should say the window is inferred.
   */
  engagementInferred: boolean;
};

function nextMonth(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return monthIndex === 12 ? `${year + 1}-01` : `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function monthRange(start: string, end: string): string[] {
  if (start > end) return [];
  const months: string[] = [];
  let cursor = start;
  // Bounded so a malformed pair cannot spin: 1200 months is a century.
  for (let guard = 0; cursor <= end && guard < 1200; guard += 1) {
    months.push(cursor);
    cursor = nextMonth(cursor);
  }
  return months;
}

function statusFor(statement: CoverageStatement): CoverageStatus {
  if (statement.reconciled) return "reconciled";
  // A statement whose closing balance was never found cannot be reconciled at
  // all, which is a different problem from one that reconciles badly. Saying so
  // points at the extraction rather than at the bookkeeping.
  if (!statement.hasClosingBalance && statement.transactionCount > 0) return "transactions_only";
  return "present";
}

export function buildCoverage(statements: CoverageStatement[], engagement: Engagement = { startMonth: null, endMonth: null, expectedAccounts: [] }): CoverageResult {
  const byAccount = new Map<string, Map<string, CoverageStatement>>();

  for (const statement of statements) {
    if (!statement.month) continue;
    const account = byAccount.get(statement.accountLabel) ?? new Map<string, CoverageStatement>();
    // Two statements in one account-month: keep the reconciled one, since that
    // is the better evidence the month is covered.
    const existing = account.get(statement.month);
    if (!existing || (!existing.reconciled && statement.reconciled)) account.set(statement.month, statement);
    byAccount.set(statement.accountLabel, account);
  }

  for (const expected of engagement.expectedAccounts) {
    // An expected account with no statements at all is the most important thing
    // this view can show, so it gets a row even though it has no data.
    if (!byAccount.has(expected)) byAccount.set(expected, new Map());
  }

  const observedMonths = statements.map((statement) => statement.month).filter(Boolean).sort();
  const engagementInferred = !engagement.startMonth || !engagement.endMonth;

  const startMonth = engagement.startMonth ?? observedMonths[0] ?? null;
  const endMonth = engagement.endMonth ?? observedMonths[observedMonths.length - 1] ?? null;
  const months = startMonth && endMonth ? monthRange(startMonth, endMonth) : [];

  const rows: CoverageRow[] = [];
  const missing: Array<{ accountLabel: string; month: string }> = [];
  let expectedCells = 0;
  let presentCells = 0;

  for (const [accountLabel, accountMonths] of [...byAccount.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const accountObserved = [...accountMonths.keys()].sort();

    // Without a configured engagement, an account is only accountable for the
    // span it demonstrably existed across — between its own first and last
    // statement. Months before it appeared are not evidence of anything, so a
    // second account opened halfway through the year does not manufacture six
    // "missing" statements that were never owed.
    const accountStart = engagement.startMonth ?? accountObserved[0] ?? null;
    const accountEnd = engagement.endMonth ?? accountObserved[accountObserved.length - 1] ?? null;
    const isAccountable = (month: string) =>
      accountStart !== null && accountEnd !== null && month >= accountStart && month <= accountEnd;

    const cells: CoverageCell[] = [];
    for (const month of months) {
      const statement = accountMonths.get(month);

      if (statement) {
        cells.push({ month, status: statusFor(statement) });
        expectedCells += 1;
        presentCells += 1;
        continue;
      }

      cells.push({ month, status: "missing" });

      // Only an accountable month counts as owed. Outside that span the cell is
      // rendered as missing but is excluded from the percentage, because it was
      // never expected in the first place.
      if (isAccountable(month)) {
        expectedCells += 1;
        missing.push({ accountLabel, month });
      }
    }

    rows.push({ accountLabel, cells });
  }

  return {
    months,
    rows,
    coveragePercent: expectedCells ? Math.round((presentCells / expectedCells) * 100) : 0,
    missing: missing.sort((a, b) => a.month.localeCompare(b.month) || a.accountLabel.localeCompare(b.accountLabel)),
    accountsTracked: byAccount.size,
    statementsReceived: statements.length,
    statementsReconciled: statements.filter((statement) => statement.reconciled).length,
    engagementInferred,
  };
}

/**
 * Cashflow analysis over statement data.
 *
 * Deterministic aggregation of transactions already extracted and classified —
 * no model call, per the instruction to compute this class of thing from the
 * database.
 *
 * Two things here are easy to get wrong in ways that look right:
 *
 * 1. Confirmed inter-account transfers must be EXCLUDED. A R50,000 transfer
 *    between two accounts the business owns appears as R50,000 of outflow on
 *    one statement and R50,000 of inflow on the other. Counted, it inflates
 *    both totals while leaving net movement correct — so the net looks fine and
 *    every gross figure is wrong. PR 5 produces those confirmations; this is
 *    what they are for.
 *
 * 2. A monthly average is only as honest as the months it divides by. If March
 *    is missing because the statement was never uploaded, dividing by the
 *    calendar span treats March as a zero month and understates the average;
 *    dividing by observed months silently pretends March never existed. Neither
 *    is right, so both counts are reported and the caller can say so.
 */

export type CashflowInput = {
  transactionId: string;
  date: string | null;
  debit: number | null;
  credit: number | null;
  accountCategory: string;
  bankCharge: boolean;
};

export type CashflowMonth = {
  /** YYYY-MM */
  month: string;
  inflow: number;
  outflow: number;
  net: number;
  bankCharges: number;
  transactionCount: number;
};

export type CategoryTotal = {
  category: string;
  amount: number;
  count: number;
};

export type CashflowSummary = {
  months: CashflowMonth[];
  totalInflow: number;
  totalOutflow: number;
  netMovement: number;
  bankChargesTotal: number;
  /** Months that actually contain transactions. */
  monthsObserved: number;
  /**
   * Calendar months from the first to the last, inclusive.
   *
   * When this exceeds monthsObserved there is a gap — most often a statement
   * that was never uploaded — and every monthly average below is drawn from an
   * incomplete picture. Reported so the caller can say so rather than quietly
   * averaging over a hole.
   */
  monthsSpanned: number;
  hasGaps: boolean;
  averageMonthlyInflow: number;
  averageMonthlyOutflow: number;
  expenseCategories: CategoryTotal[];
  incomeCategories: CategoryTotal[];
  /** Transactions removed as confirmed internal transfers. */
  excludedTransferCount: number;
};

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function monthsBetween(first: string, last: string): number {
  const [firstYear, firstMonth] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  if (!firstYear || !lastYear) return 0;
  return (lastYear - firstYear) * 12 + (lastMonth - firstMonth) + 1;
}

function topCategories(totals: Map<string, { amount: number; count: number }>): CategoryTotal[] {
  return [...totals.entries()]
    .map(([category, value]) => ({ category, amount: value.amount, count: value.count }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
}

/**
 * Summarise cashflow, excluding transactions confirmed as internal transfers.
 *
 * `confirmedTransferIds` should contain BOTH legs of every confirmed transfer.
 * Removing only one leg would be worse than removing neither: the totals would
 * then disagree with the net movement by the transfer amount.
 */
export function summarizeCashflow(
  rows: CashflowInput[],
  confirmedTransferIds: Set<string> = new Set(),
): CashflowSummary {
  const byMonth = new Map<string, CashflowMonth>();
  const expenses = new Map<string, { amount: number; count: number }>();
  const income = new Map<string, { amount: number; count: number }>();

  let totalInflow = 0;
  let totalOutflow = 0;
  let bankChargesTotal = 0;
  let excludedTransferCount = 0;

  for (const row of rows) {
    if (confirmedTransferIds.has(row.transactionId)) {
      excludedTransferCount += 1;
      continue;
    }
    if (!row.date) continue;

    const key = monthKey(row.date);
    const bucket = byMonth.get(key) ?? { month: key, inflow: 0, outflow: 0, net: 0, bankCharges: 0, transactionCount: 0 };

    const inflow = row.credit ?? 0;
    const outflow = row.debit ?? 0;

    bucket.inflow += inflow;
    bucket.outflow += outflow;
    bucket.net = bucket.inflow - bucket.outflow;
    bucket.transactionCount += 1;
    if (row.bankCharge) bucket.bankCharges += outflow;

    byMonth.set(key, bucket);

    totalInflow += inflow;
    totalOutflow += outflow;
    if (row.bankCharge) bankChargesTotal += outflow;

    // A transaction contributes to the category breakdown on the side it
    // actually moved money, so a refund posted as a credit is not counted as
    // expenditure it never was.
    if (outflow > 0) {
      const current = expenses.get(row.accountCategory) ?? { amount: 0, count: 0 };
      expenses.set(row.accountCategory, { amount: current.amount + outflow, count: current.count + 1 });
    }
    if (inflow > 0) {
      const current = income.get(row.accountCategory) ?? { amount: 0, count: 0 };
      income.set(row.accountCategory, { amount: current.amount + inflow, count: current.count + 1 });
    }
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const monthsObserved = months.length;
  const monthsSpanned = monthsObserved ? monthsBetween(months[0].month, months[monthsObserved - 1].month) : 0;

  return {
    months,
    totalInflow,
    totalOutflow,
    netMovement: totalInflow - totalOutflow,
    bankChargesTotal,
    monthsObserved,
    monthsSpanned,
    hasGaps: monthsSpanned > monthsObserved,
    // Divided by observed months. With a gap the figure is drawn from an
    // incomplete picture, which hasGaps announces rather than hides.
    averageMonthlyInflow: monthsObserved ? totalInflow / monthsObserved : 0,
    averageMonthlyOutflow: monthsObserved ? totalOutflow / monthsObserved : 0,
    expenseCategories: topCategories(expenses),
    incomeCategories: topCategories(income),
    excludedTransferCount,
  };
}

/**
 * Closing balance per account, taken from the latest statement of each.
 *
 * Balances are NOT summed here. Adding the closing balances of accounts whose
 * statements end on different dates produces a total that was never true on any
 * single day, and presenting it as "current balance" would be a figure with no
 * moment attached. The caller gets the parts, each with the date it was true.
 */
export function latestBalancesByAccount(
  runs: Array<{ accountLabel: string; periodEnd: string | null; closingBalance: number | null }>,
): Array<{ accountLabel: string; asAt: string | null; balance: number }> {
  const latest = new Map<string, { asAt: string | null; balance: number }>();

  for (const run of runs) {
    if (run.closingBalance == null) continue;
    const current = latest.get(run.accountLabel);
    const isNewer = !current || (run.periodEnd ?? "") > (current.asAt ?? "");
    if (isNewer) latest.set(run.accountLabel, { asAt: run.periodEnd, balance: run.closingBalance });
  }

  return [...latest.entries()]
    .map(([accountLabel, value]) => ({ accountLabel, asAt: value.asAt, balance: value.balance }))
    .sort((a, b) => a.accountLabel.localeCompare(b.accountLabel));
}

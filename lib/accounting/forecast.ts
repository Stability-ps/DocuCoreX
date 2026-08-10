/**
 * Cash forecasting from confirmed inputs.
 *
 * The instruction: "Do not give false financial certainty."
 *
 * A projected balance is the single most quotable number this product can
 * produce. Someone will read "R412,000 in 60 days" and decide whether to make a
 * payment on it. So the honesty here cannot be a disclaimer under the chart; it
 * has to be in what the module is willing to compute at all.
 *
 * Three rules carry that:
 *
 * 1. Only CONFIRMED recurring commitments are projected. A pattern the system
 *    merely detected is a hypothesis, and PR 6's confirm/dismiss store exists
 *    precisely so a person decides which hypotheses become obligations. Feeding
 *    detected-but-unconfirmed patterns into a forecast would launder a guess
 *    into a figure.
 *
 * 2. Committed outflows and estimated inflows are never mixed into one number.
 *    Outflows are known — a confirmed debit order is a fact about the future.
 *    Inflows extrapolated from history are not. Presenting a single balance
 *    built from both makes the guess inherit the credibility of the fact, so
 *    both readings are returned side by side and neither is "the" answer.
 *
 * 3. Every figure carries the assumptions it rests on, returned as text. If an
 *    assumption cannot be stated plainly, the projection should not be shown.
 */

export type ForecastCommitment = {
  merchant: string;
  amount: number;
  /** Estimated from the observed rhythm. */
  expectedDate: string;
  frequency: string;
  confidence: number;
};

export type ForecastHorizon = {
  days: 30 | 60 | 90;
  endDate: string;
  committedOutflow: number;
  /** Extrapolated from history. An estimate, and separated for that reason. */
  estimatedInflow: number;
  /** Opening balance less committed outflows. Assumes no further income. */
  balanceCommittedOnly: number;
  /** The same, with estimated inflows added. The optimistic reading. */
  balanceWithEstimatedInflow: number;
};

export type CashShortfall = {
  /** The first horizon at which the committed-only balance goes negative. */
  days: number;
  date: string;
  projectedBalance: number;
  largestCommitments: ForecastCommitment[];
};

export type CashForecast =
  | { possible: false; reason: string; assumptions: string[] }
  | {
      possible: true;
      openingBalance: number;
      openingBalanceAsAt: string;
      /** Days between the balance date and the date the forecast was run. */
      balanceAgeDays: number;
      horizons: ForecastHorizon[];
      commitments: ForecastCommitment[];
      shortfall: CashShortfall | null;
      assumptions: string[];
    };

export type ForecastInput = {
  /** Latest known balance, and the date it was true. */
  openingBalance: number | null;
  openingBalanceAsAt: string | null;
  /** CONFIRMED recurring patterns only. Detected ones must not be passed here. */
  confirmedCommitments: Array<{
    merchant: string;
    averageAmount: number;
    medianIntervalDays: number;
    nextExpected: string;
    frequency: string;
    confidence: number;
  }>;
  /** Mean monthly inflow observed historically, or null if unknown. */
  averageMonthlyInflow: number | null;
  /** Months of history the average rests on. */
  monthsObserved: number;
  /** The date to forecast from. Passed in rather than read from the clock. */
  today: string;
};

const DAY_MS = 86_400_000;

/** A balance older than this is too stale to project from without saying so. */
export const STALE_BALANCE_DAYS = 45;

/** Below this, an inflow average is not an average. */
const MIN_MONTHS_FOR_INFLOW_ESTIMATE = 3;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * Expand a confirmed commitment into every occurrence inside the window.
 *
 * A monthly debit order falls three times in 90 days, not once. Counting it
 * once would understate committed outflows by two thirds — the failure mode
 * that makes a forecast look comfortable right up until it is wrong.
 */
function occurrencesWithin(
  commitment: ForecastInput["confirmedCommitments"][number],
  today: string,
  horizonEnd: string,
): ForecastCommitment[] {
  const occurrences: ForecastCommitment[] = [];
  const interval = Math.max(1, Math.round(commitment.medianIntervalDays));
  let cursor = commitment.nextExpected;

  // A commitment whose next date has already passed is projected from today
  // rather than skipped: the obligation did not disappear because a statement
  // has not arrived yet.
  if (cursor < today) cursor = today;

  for (let guard = 0; cursor <= horizonEnd && guard < 400; guard += 1) {
    occurrences.push({
      merchant: commitment.merchant,
      amount: commitment.averageAmount,
      expectedDate: cursor,
      frequency: commitment.frequency,
      confidence: commitment.confidence,
    });
    cursor = addDays(cursor, interval);
  }

  return occurrences;
}

export function buildCashForecast(input: ForecastInput): CashForecast {
  const assumptions: string[] = [];

  if (input.openingBalance == null || !input.openingBalanceAsAt) {
    return {
      possible: false,
      reason:
        "A cash forecast needs a known closing balance to start from. No statement with a closing balance has been processed yet.",
      assumptions,
    };
  }

  if (!input.confirmedCommitments.length) {
    return {
      possible: false,
      // Deliberately not a zero-commitment forecast. A projection that simply
      // repeats the current balance for 90 days looks like a finding and is
      // just an absence of input.
      reason:
        "No recurring commitments have been confirmed yet. Confirm the recurring payments you expect to continue, and the forecast will project them.",
      assumptions,
    };
  }

  const balanceAgeDays = daysBetween(input.openingBalanceAsAt, input.today);
  assumptions.push(
    `Starting balance of ${input.openingBalance.toFixed(2)} as at ${input.openingBalanceAsAt}${
      balanceAgeDays > STALE_BALANCE_DAYS ? ` — ${balanceAgeDays} days old, so later movements may not be reflected` : ""
    }.`,
  );
  assumptions.push(
    `Only the ${input.confirmedCommitments.length} confirmed recurring commitment${
      input.confirmedCommitments.length === 1 ? "" : "s"
    } are projected. Detected but unconfirmed patterns are excluded.`,
  );

  const canEstimateInflow =
    input.averageMonthlyInflow != null && input.averageMonthlyInflow > 0 && input.monthsObserved >= MIN_MONTHS_FOR_INFLOW_ESTIMATE;

  if (canEstimateInflow) {
    assumptions.push(
      `Estimated income of ${input.averageMonthlyInflow!.toFixed(2)} per month is averaged from ${input.monthsObserved} months of history. It is an estimate, not a commitment, and is shown separately.`,
    );
  } else {
    assumptions.push(
      input.monthsObserved > 0
        ? `Income is not projected: ${input.monthsObserved} month${input.monthsObserved === 1 ? "" : "s"} of history is too little to average.`
        : "Income is not projected: there is no history to average.",
    );
  }

  const horizons: ForecastHorizon[] = ([30, 60, 90] as const).map((days) => {
    const endDate = addDays(input.today, days);
    const committedOutflow = input.confirmedCommitments
      .flatMap((commitment) => occurrencesWithin(commitment, input.today, endDate))
      .reduce((sum, occurrence) => sum + occurrence.amount, 0);

    const estimatedInflow = canEstimateInflow ? (input.averageMonthlyInflow! * days) / 30 : 0;
    const balanceCommittedOnly = input.openingBalance! - committedOutflow;

    return {
      days,
      endDate,
      committedOutflow,
      estimatedInflow,
      balanceCommittedOnly,
      balanceWithEstimatedInflow: balanceCommittedOnly + estimatedInflow,
    };
  });

  const ninetyDayEnd = addDays(input.today, 90);
  const commitments = input.confirmedCommitments
    .flatMap((commitment) => occurrencesWithin(commitment, input.today, ninetyDayEnd))
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));

  // The shortfall is read from the committed-only line, which assumes no further
  // income. That is the conservative reading and the one worth warning on; the
  // assumption is stated so it is not mistaken for a prediction of insolvency.
  const breaching = horizons.find((horizon) => horizon.balanceCommittedOnly < 0);
  const shortfall: CashShortfall | null = breaching
    ? {
        days: breaching.days,
        date: breaching.endDate,
        projectedBalance: breaching.balanceCommittedOnly,
        largestCommitments: [...commitments].sort((a, b) => b.amount - a.amount).slice(0, 5),
      }
    : null;

  if (shortfall) {
    assumptions.push(
      "The shortfall assumes no further income is received. It is a projection from confirmed commitments, not a prediction of insolvency.",
    );
  }

  return {
    possible: true,
    openingBalance: input.openingBalance,
    openingBalanceAsAt: input.openingBalanceAsAt,
    balanceAgeDays,
    horizons,
    commitments,
    shortfall,
    assumptions,
  };
}

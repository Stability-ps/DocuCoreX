import assert from "node:assert/strict";
import test from "node:test";

import { STALE_BALANCE_DAYS, buildCashForecast, type ForecastInput } from "../../lib/accounting/forecast.ts";

function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    openingBalance: 100000,
    openingBalanceAsAt: "2025-08-31",
    confirmedCommitments: [
      {
        merchant: "WesBank",
        averageAmount: 18450,
        medianIntervalDays: 30,
        nextExpected: "2025-09-01",
        frequency: "monthly",
        confidence: 88,
      },
    ],
    averageMonthlyInflow: 60000,
    monthsObserved: 6,
    today: "2025-09-01",
    ...overrides,
  };
}

test("a monthly commitment is projected every time it falls, not once", () => {
  // Counting a monthly debit order once over 90 days understates committed
  // outflow by two thirds — the failure that makes a forecast look comfortable
  // right up until it is wrong.
  const forecast = buildCashForecast(input());
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;

  const ninety = forecast.horizons.find((h) => h.days === 90)!;
  assert.equal(ninety.committedOutflow, 18450 * 4, "1 Sep, 1 Oct, 31 Oct, 30 Nov");

  const thirty = forecast.horizons.find((h) => h.days === 30)!;
  assert.equal(thirty.committedOutflow, 18450 * 2);
});

test("committed outflows and estimated inflows are never merged", () => {
  // A guess must not inherit the credibility of a fact.
  const forecast = buildCashForecast(input());
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;

  const thirty = forecast.horizons.find((h) => h.days === 30)!;
  assert.equal(thirty.balanceCommittedOnly, 100000 - 18450 * 2);
  assert.equal(thirty.balanceWithEstimatedInflow, thirty.balanceCommittedOnly + 60000);
  assert.notEqual(thirty.balanceCommittedOnly, thirty.balanceWithEstimatedInflow);
});

test("unconfirmed patterns cannot reach the forecast", () => {
  // The module takes confirmed commitments only; there is no parameter through
  // which a detected-but-unconfirmed pattern could arrive.
  const forecast = buildCashForecast(input({ confirmedCommitments: [] }));
  assert.equal(forecast.possible, false);
  if (forecast.possible) return;
  assert.match(forecast.reason, /No recurring commitments have been confirmed/);
});

test("no confirmed commitments refuses rather than projecting a flat line", () => {
  // A projection that repeats today's balance for 90 days looks like a finding
  // and is an absence of input.
  const forecast = buildCashForecast(input({ confirmedCommitments: [] }));
  assert.equal(forecast.possible, false);
});

test("no known balance refuses outright", () => {
  for (const override of [{ openingBalance: null }, { openingBalanceAsAt: null }]) {
    const forecast = buildCashForecast(input(override));
    assert.equal(forecast.possible, false);
    if (forecast.possible) continue;
    assert.match(forecast.reason, /closing balance/);
  }
});

test("a stale opening balance is disclosed in the assumptions", () => {
  const forecast = buildCashForecast(
    input({ openingBalanceAsAt: "2025-06-01", today: "2025-09-01" }),
  );
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;
  assert.ok(forecast.balanceAgeDays > STALE_BALANCE_DAYS);
  assert.ok(forecast.assumptions.some((line) => /days old/.test(line)), "staleness is stated, not silent");
});

test("thin history suppresses the income estimate rather than guessing", () => {
  const forecast = buildCashForecast(input({ monthsObserved: 1 }));
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;

  const thirty = forecast.horizons.find((h) => h.days === 30)!;
  assert.equal(thirty.estimatedInflow, 0);
  assert.equal(thirty.balanceWithEstimatedInflow, thirty.balanceCommittedOnly);
  assert.ok(forecast.assumptions.some((line) => /too little to average/.test(line)));
});

test("every projection states the assumptions it rests on", () => {
  const forecast = buildCashForecast(input());
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;

  assert.ok(forecast.assumptions.length >= 3);
  assert.ok(forecast.assumptions.some((line) => /Starting balance/.test(line)));
  assert.ok(
    forecast.assumptions.some((line) => /Detected but unconfirmed patterns are excluded/.test(line)),
    "the most important assumption is stated explicitly",
  );
  assert.ok(forecast.assumptions.some((line) => /estimate, not a commitment/.test(line)));
});

test("a shortfall is reported with its assumption, not as a prediction", () => {
  const forecast = buildCashForecast(
    input({
      openingBalance: 20000,
      confirmedCommitments: [
        {
          merchant: "WesBank",
          averageAmount: 18450,
          medianIntervalDays: 30,
          nextExpected: "2025-09-01",
          frequency: "monthly",
          confidence: 88,
        },
      ],
    }),
  );
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;

  assert.ok(forecast.shortfall, "20,000 cannot absorb two 18,450 payments");
  assert.equal(forecast.shortfall!.days, 30);
  assert.ok(forecast.shortfall!.largestCommitments.length > 0);
  assert.ok(
    forecast.assumptions.some((line) => /not a prediction of insolvency/.test(line)),
    "the conservative reading is labelled as such",
  );
});

test("a healthy balance reports no shortfall", () => {
  const forecast = buildCashForecast(input({ openingBalance: 5_000_000 }));
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;
  assert.equal(forecast.shortfall, null);
});

test("an overdue commitment is projected from today, not skipped", () => {
  // The obligation did not disappear because the statement has not arrived.
  const forecast = buildCashForecast(
    input({
      today: "2025-09-15",
      confirmedCommitments: [
        {
          merchant: "Overdue Co",
          averageAmount: 1000,
          medianIntervalDays: 30,
          nextExpected: "2025-08-01",
          frequency: "monthly",
          confidence: 80,
        },
      ],
    }),
  );
  assert.equal(forecast.possible, true);
  if (!forecast.possible) return;
  assert.ok(forecast.commitments.length >= 3, "still projected across the 90 days");
  assert.ok(forecast.commitments.every((c) => c.expectedDate >= "2025-09-15"), "never dated in the past");
});

test("the forecast date is supplied, never read from the clock", () => {
  // Determinism: the same inputs must produce the same output in a test, in CI
  // and in production.
  const first = buildCashForecast(input({ today: "2025-09-01" }));
  const second = buildCashForecast(input({ today: "2025-09-01" }));
  assert.deepEqual(first, second);
});

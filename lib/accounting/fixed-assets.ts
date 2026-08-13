/**
 * Fixed assets: types and the two pure calculations — a month's depreciation
 * charge, and a disposal's gain or loss. No server imports — the browser and
 * the tests both use this.
 *
 * Cost is stated, not derived (see migration 042). Accumulated depreciation
 * and net book value ARE derived, from postings, by
 * accounting_fixed_asset_register — this module never invents a figure the
 * register wouldn't agree with; it only proposes what to post next.
 */

export type DepreciationMethod = "straight_line" | "reducing_balance" | "none";

export type FixedAsset = {
  id: string;
  description: string;
  assetAccountId: string;
  assetAccountCode: string;
  assetAccountName: string;
  accumulatedDepreciationAccountId: string;
  acquisitionDate: string;
  cost: number;
  residualValue: number;
  depreciationMethod: DepreciationMethod;
  usefulLifeMonths: number | null;
  depreciationRatePercent: number | null;
  accumulatedDepreciation: number;
  netBookValue: number;
  isActive: boolean;
  disposalDate: string | null;
  disposalProceeds: number | null;
};

export const DEPRECIATION_METHOD_LABELS: Record<DepreciationMethod, string> = {
  straight_line: "Straight line",
  reducing_balance: "Reducing balance",
  none: "Not depreciated",
};

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * This month's depreciation charge for one asset.
 *
 * Capped so an asset never depreciates past its residual value regardless of
 * method — a reducing-balance asset run for long enough would otherwise
 * asymptote toward zero rather than stop at what was stated as recoverable.
 */
export function monthlyDepreciationCharge(
  asset: Pick<FixedAsset, "cost" | "residualValue" | "depreciationMethod" | "usefulLifeMonths" | "depreciationRatePercent"> & {
    acquisitionDate: string;
    disposalDate: string | null;
  },
  priorAccumulatedDepreciation: number,
  monthEnd: string,
): number {
  if (asset.depreciationMethod === "none") return 0;
  if (asset.acquisitionDate > monthEnd) return 0;
  // Disposed before this month-end: nothing left to charge.
  if (asset.disposalDate && asset.disposalDate < monthEnd) return 0;

  const depreciableBase = round2(asset.cost - asset.residualValue);
  const remaining = round2(depreciableBase - priorAccumulatedDepreciation);
  if (remaining <= 0) return 0;

  let charge: number;
  if (asset.depreciationMethod === "straight_line") {
    if (!asset.usefulLifeMonths) return 0;
    charge = depreciableBase / asset.usefulLifeMonths;
  } else {
    if (!asset.depreciationRatePercent) return 0;
    const openingNetBookValue = asset.cost - priorAccumulatedDepreciation;
    charge = openingNetBookValue * (asset.depreciationRatePercent / 100 / 12);
  }

  return round2(Math.min(Math.max(charge, 0), remaining));
}

export type DisposalEntry = {
  /** Clears the asset's cost: a credit to the asset account. */
  costCredit: number;
  /** Clears the contra balance: a debit to the accumulated-depreciation account. */
  accumulatedDepreciationDebit: number;
  /** What was received, if anything: a debit to wherever the proceeds landed. */
  proceedsDebit: number;
  /** Credit to gain-on-disposal when proceeds exceed net book value. */
  gain: number;
  /** Debit to loss-on-disposal when proceeds fall short of net book value. */
  loss: number;
};

/**
 * The disposal journal, as figures rather than as journal lines — the caller
 * attaches account ids, because this module doesn't know the entity's chart.
 *
 * Gain/(loss) = proceeds − net book value. The two plug lines are mutually
 * exclusive: a disposal is either a gain or a loss, never both, and never
 * neither unless it disposes at exactly net book value.
 */
export function disposalEntry(input: { cost: number; accumulatedDepreciation: number; proceeds: number }): DisposalEntry {
  const netBookValue = round2(input.cost - input.accumulatedDepreciation);
  const result = round2(input.proceeds - netBookValue);
  return {
    costCredit: round2(input.cost),
    accumulatedDepreciationDebit: round2(input.accumulatedDepreciation),
    proceedsDebit: round2(input.proceeds),
    gain: result > 0 ? result : 0,
    loss: result < 0 ? round2(-result) : 0,
  };
}

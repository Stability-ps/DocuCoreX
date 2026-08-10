/**
 * Flow of funds: where money came from, and where it went.
 *
 * The instruction this module is shaped by:
 *
 *   "Do not build a visually impressive chart that merely says:
 *    Income Uncategorized → Expense Uncategorized"
 *
 * A flow diagram is the most persuasive view in an accounting product. Thick
 * bands, clear arrows, an obvious story. That persuasiveness is exactly the
 * problem when the classification underneath is thin: the picture reads as
 * insight regardless of whether the categories mean anything, and a reader has
 * no way to tell a well-classified statement from a badly-classified one by
 * looking at it. A weak diagram does not look weak.
 *
 * So the gate is the feature. This module refuses to produce a graph until
 * enough of the money is actually attributed, and reports why not in terms of
 * what would fix it.
 *
 * The threshold is measured by VALUE, not by transaction count. A statement can
 * be 95% classified by count and still have its single largest payment sitting
 * in Suspense — and that one payment is the thing a flow diagram would most
 * mislead about.
 */

import { isUnresolvedAccountingCategory } from "@/lib/accounting/review-options";

export type FlowInput = {
  transactionId: string;
  debit: number | null;
  credit: number | null;
  accountCategory: string;
};

export type FlowNode = {
  id: string;
  label: string;
  kind: "source" | "hub" | "use";
  amount: number;
};

export type FlowEdge = {
  from: string;
  to: string;
  amount: number;
  /** Share of that side's total, for proportional rendering. */
  share: number;
};

export type FlowQuality = {
  /** Share of total money moved that carries a resolved category, 0-1. */
  classifiedValueShare: number;
  classifiedCountShare: number;
  totalValue: number;
  unclassifiedValue: number;
  transactionCount: number;
};

export type FlowOfFunds =
  | { sufficient: true; quality: FlowQuality; nodes: FlowNode[]; edges: FlowEdge[]; hubLabel: string }
  | { sufficient: false; quality: FlowQuality; reason: string };

/**
 * Enough of the money must be attributed before a picture is drawn.
 *
 * 0.7 is a judgement, not a discovery. Below it, roughly a third of the money
 * is unattributed and the largest band in any honest diagram would be
 * "Unclassified" — at which point the diagram is reporting the state of the
 * bookkeeping rather than the business, and a sentence says that better.
 */
export const MIN_CLASSIFIED_VALUE_SHARE = 0.7;

/**
 * Below this, proportions are noise. Three transactions can be 100% classified
 * and still say nothing about where a business's money goes.
 */
export const MIN_TRANSACTIONS = 12;

function assessQuality(rows: FlowInput[]): FlowQuality {
  let totalValue = 0;
  let unclassifiedValue = 0;
  let classifiedCount = 0;

  for (const row of rows) {
    const value = (row.debit ?? 0) + (row.credit ?? 0);
    totalValue += value;
    if (isUnresolvedAccountingCategory(row.accountCategory)) unclassifiedValue += value;
    else classifiedCount += 1;
  }

  return {
    classifiedValueShare: totalValue ? (totalValue - unclassifiedValue) / totalValue : 0,
    classifiedCountShare: rows.length ? classifiedCount / rows.length : 0,
    totalValue,
    unclassifiedValue,
    transactionCount: rows.length,
  };
}

/**
 * Build the flow graph, or explain why one would mislead.
 *
 * `confirmedTransferIds` are excluded for the same reason as in cashflow: money
 * moving between the business's own accounts is not a source of funds and not a
 * use of them, and drawing it as both would show the largest band on the chart
 * being money that never entered or left the business.
 */
export function buildFlowOfFunds(
  rows: FlowInput[],
  options: { hubLabel?: string; confirmedTransferIds?: Set<string> } = {},
): FlowOfFunds {
  const confirmed = options.confirmedTransferIds ?? new Set<string>();
  const usable = rows.filter((row) => !confirmed.has(row.transactionId) && ((row.debit ?? 0) > 0 || (row.credit ?? 0) > 0));
  const quality = assessQuality(usable);

  if (quality.transactionCount < MIN_TRANSACTIONS) {
    return {
      sufficient: false,
      quality,
      reason: `Flow of Funds needs at least ${MIN_TRANSACTIONS} transactions to show meaningful proportions. This selection has ${quality.transactionCount}.`,
    };
  }

  if (quality.classifiedValueShare < MIN_CLASSIFIED_VALUE_SHARE) {
    const percent = Math.round(quality.classifiedValueShare * 100);
    return {
      sufficient: false,
      // Says what is wrong and what would fix it, in the terms the reader can
      // act on — a percentage of money, not a count of rows.
      reason: `More transaction classification is required before Flow of Funds can be meaningfully generated. ${percent}% of the money moved is currently categorised; at least ${Math.round(
        MIN_CLASSIFIED_VALUE_SHARE * 100,
      )}% is needed.`,
      quality,
    };
  }

  const hubLabel = options.hubLabel ?? "Bank accounts";
  const sources = new Map<string, number>();
  const uses = new Map<string, number>();

  for (const row of usable) {
    // Unresolved money is still drawn, under its own name. Having passed the
    // gate it is a minority, and hiding it would make the totals disagree with
    // the statement — a diagram whose parts do not sum to the whole is worse
    // than one with an honest "Unclassified" band.
    const label = isUnresolvedAccountingCategory(row.accountCategory) ? "Unclassified" : row.accountCategory;
    const credit = row.credit ?? 0;
    const debit = row.debit ?? 0;
    if (credit > 0) sources.set(label, (sources.get(label) ?? 0) + credit);
    if (debit > 0) uses.set(label, (uses.get(label) ?? 0) + debit);
  }

  const sourceTotal = [...sources.values()].reduce((sum, value) => sum + value, 0);
  const useTotal = [...uses.values()].reduce((sum, value) => sum + value, 0);

  const nodes: FlowNode[] = [
    ...[...sources.entries()].map(([label, amount]) => ({ id: `source:${label}`, label, kind: "source" as const, amount })),
    { id: "hub", label: hubLabel, kind: "hub" as const, amount: Math.max(sourceTotal, useTotal) },
    ...[...uses.entries()].map(([label, amount]) => ({ id: `use:${label}`, label, kind: "use" as const, amount })),
  ];

  const edges: FlowEdge[] = [
    ...[...sources.entries()].map(([label, amount]) => ({
      from: `source:${label}`,
      to: "hub",
      amount,
      share: sourceTotal ? amount / sourceTotal : 0,
    })),
    ...[...uses.entries()].map(([label, amount]) => ({
      from: "hub",
      to: `use:${label}`,
      amount,
      share: useTotal ? amount / useTotal : 0,
    })),
  ];

  // Largest first on each side, then by name so the same data renders the same
  // way twice.
  nodes.sort((a, b) => a.kind.localeCompare(b.kind) || b.amount - a.amount || a.label.localeCompare(b.label));
  edges.sort((a, b) => b.amount - a.amount || a.from.localeCompare(b.from));

  return { sufficient: true, quality, nodes, edges, hubLabel };
}

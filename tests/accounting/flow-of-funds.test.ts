import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// flow-of-funds imports isUnresolvedAccountingCategory, whose own module has a
// "@/" value import, so the alias hook must be registered for the chain to load.
register("./alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const { buildFlowOfFunds, MIN_CLASSIFIED_VALUE_SHARE, MIN_TRANSACTIONS } = await import("@/lib/accounting/flow-of-funds.ts");
type FlowInput = import("@/lib/accounting/flow-of-funds.ts").FlowInput;

let counter = 0;
function tx(overrides: Partial<FlowInput>): FlowInput {
  counter += 1;
  return { transactionId: `t-${counter}`, debit: null, credit: null, accountCategory: "Supplies", ...overrides };
}

/** A well-classified set comfortably over both thresholds. */
function healthy(): FlowInput[] {
  return [
    ...Array.from({ length: 6 }, () => tx({ credit: 10000, accountCategory: "Revenue" })),
    ...Array.from({ length: 6 }, () => tx({ debit: 4000, accountCategory: "Payroll" })),
    ...Array.from({ length: 4 }, () => tx({ debit: 1000, accountCategory: "Rent" })),
  ];
}

test("a well-classified set produces sources, a hub and uses", () => {
  const flow = buildFlowOfFunds(healthy());
  assert.equal(flow.sufficient, true);
  if (!flow.sufficient) return;

  assert.ok(flow.nodes.some((node) => node.kind === "hub"));
  assert.deepEqual(
    flow.nodes.filter((n) => n.kind === "source").map((n) => n.label),
    ["Revenue"],
  );
  assert.deepEqual(
    flow.nodes.filter((n) => n.kind === "use").map((n) => n.label),
    ["Payroll", "Rent"],
  );
});

test("too little classification refuses to draw anything", () => {
  // The failure this exists to prevent: a persuasive picture whose largest band
  // is "Unclassified". A weak diagram does not look weak.
  const rows = [
    ...Array.from({ length: 10 }, () => tx({ debit: 10000, accountCategory: "Suspense / Review Required" })),
    ...Array.from({ length: 6 }, () => tx({ debit: 1000, accountCategory: "Rent" })),
  ];
  const flow = buildFlowOfFunds(rows);
  assert.equal(flow.sufficient, false);
  if (flow.sufficient) return;
  assert.match(flow.reason, /More transaction classification is required/);
  // The reason must say what would fix it, in money terms.
  assert.match(flow.reason, /%/);
});

test("the gate is measured by value, not by transaction count", () => {
  // 95% classified by COUNT, but the single largest payment is unclassified —
  // exactly the case a flow diagram would most mislead about.
  const rows = [
    ...Array.from({ length: 19 }, () => tx({ debit: 100, accountCategory: "Rent" })),
    tx({ debit: 100000, accountCategory: "Uncategorised" }),
  ];
  const flow = buildFlowOfFunds(rows);
  assert.equal(flow.sufficient, false);
  assert.ok(flow.quality.classifiedCountShare > 0.9, "count share looks excellent");
  assert.ok(flow.quality.classifiedValueShare < 0.1, "value share is what matters");
});

test("too few transactions refuses even at perfect classification", () => {
  // Three transactions can be 100% classified and still say nothing about where
  // a business's money goes.
  const rows = Array.from({ length: 3 }, () => tx({ debit: 100, accountCategory: "Rent" }));
  const flow = buildFlowOfFunds(rows);
  assert.equal(flow.sufficient, false);
  if (flow.sufficient) return;
  assert.match(flow.reason, new RegExp(`${MIN_TRANSACTIONS} transactions`));
  assert.equal(flow.quality.classifiedValueShare, 1);
});

test("residual unclassified money is drawn, not hidden", () => {
  // Having passed the gate it is a minority — but dropping it would make the
  // diagram's parts disagree with the statement totals.
  const rows = [
    ...Array.from({ length: 15 }, () => tx({ debit: 1000, accountCategory: "Rent" })),
    ...Array.from({ length: 3 }, () => tx({ debit: 1000, accountCategory: "Uncategorised" })),
  ];
  const flow = buildFlowOfFunds(rows);
  assert.equal(flow.sufficient, true);
  if (!flow.sufficient) return;
  assert.ok(flow.nodes.some((node) => node.label === "Unclassified"), "shown under its own name");

  const useTotal = flow.edges.filter((edge) => edge.from === "hub").reduce((sum, edge) => sum + edge.amount, 0);
  assert.equal(useTotal, 18000, "the parts sum to the whole");
});

test("confirmed transfers are excluded from the flow", () => {
  // Internal movement is neither a source of funds nor a use of them; drawn, it
  // would be the largest band on the chart while never entering or leaving the
  // business.
  const base = healthy();
  const out = tx({ debit: 500000, accountCategory: "Transfers", transactionId: "x-out" });
  const back = tx({ credit: 500000, accountCategory: "Transfers", transactionId: "x-in" });

  const withTransfer = buildFlowOfFunds([...base, out, back]);
  assert.equal(withTransfer.sufficient, true);
  if (!withTransfer.sufficient) return;
  assert.ok(withTransfer.nodes.some((node) => node.label === "Transfers"));

  const excluded = buildFlowOfFunds([...base, out, back], {
    confirmedTransferIds: new Set(["x-out", "x-in"]),
  });
  assert.equal(excluded.sufficient, true);
  if (!excluded.sufficient) return;
  assert.ok(!excluded.nodes.some((node) => node.label === "Transfers"), "internal movement is gone");
});

test("edge shares are proportions of their own side", () => {
  const flow = buildFlowOfFunds(healthy());
  assert.equal(flow.sufficient, true);
  if (!flow.sufficient) return;

  const useShares = flow.edges.filter((edge) => edge.from === "hub").reduce((sum, edge) => sum + edge.share, 0);
  assert.ok(Math.abs(useShares - 1) < 1e-9, "uses sum to 1 among themselves");

  const sourceShares = flow.edges.filter((edge) => edge.to === "hub").reduce((sum, edge) => sum + edge.share, 0);
  assert.ok(Math.abs(sourceShares - 1) < 1e-9, "sources sum to 1 among themselves");
});

test("quality is reported even when the gate refuses", () => {
  // The caller needs the numbers to tell the user how far off they are.
  const rows = Array.from({ length: 20 }, () => tx({ debit: 100, accountCategory: "Uncategorised" }));
  const flow = buildFlowOfFunds(rows);
  assert.equal(flow.sufficient, false);
  assert.equal(flow.quality.transactionCount, 20);
  assert.equal(flow.quality.unclassifiedValue, 2000);
  assert.equal(flow.quality.totalValue, 2000);
});

test("an empty set refuses rather than dividing by zero", () => {
  const flow = buildFlowOfFunds([]);
  assert.equal(flow.sufficient, false);
  assert.equal(flow.quality.classifiedValueShare, 0);
  assert.equal(flow.quality.totalValue, 0);
});

test("the threshold is a stated judgement, not a hidden constant", () => {
  assert.ok(MIN_CLASSIFIED_VALUE_SHARE > 0 && MIN_CLASSIFIED_VALUE_SHARE <= 1);
  assert.ok(MIN_TRANSACTIONS >= 1);
});

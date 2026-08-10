import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  MAX_TRANSFER_DAY_GAP,
  bestTransferCandidates,
  findTransferCandidates,
  type TransferSide,
} from "../../lib/accounting/transfers.ts";

function side(overrides: Partial<TransferSide> & { transactionId: string }): TransferSide {
  return {
    runId: "run-current",
    accountNumber: "1001",
    accountLabel: "Business Current",
    date: "2025-04-10",
    debit: null,
    credit: null,
    description: "IB TRANSFER TO SAVINGS",
    ...overrides,
  };
}

const OUT = side({ transactionId: "out-1", debit: 50000, runId: "run-current", accountNumber: "1001" });
const IN = side({ transactionId: "in-1", credit: 50000, runId: "run-savings", accountNumber: "2002", accountLabel: "Savings" });

test("the textbook pair is found and rated strong", () => {
  const [candidate] = findTransferCandidates([OUT, IN]);
  assert.equal(candidate.strength, "strong");
  assert.equal(candidate.amount, 50000);
  assert.equal(candidate.amountDelta, 0);
  assert.equal(candidate.outbound.transactionId, "out-1");
  assert.equal(candidate.inbound.transactionId, "in-1");
});

test("two legs on the SAME statement are never a transfer", () => {
  // A debit and a credit on one statement are two transactions. The legs of a
  // real transfer are recorded on two different statements.
  const candidates = findTransferCandidates([OUT, side({ transactionId: "in-same", credit: 50000, runId: "run-current" })]);
  assert.equal(candidates.length, 0);
});

test("money is never transferred to the account it came from", () => {
  const sameAccount = side({ transactionId: "in-2", credit: 50000, runId: "run-april", accountNumber: "1001" });
  assert.equal(findTransferCandidates([OUT, sameAccount]).length, 0);
});

test("an unknown account number cannot reach strong", () => {
  // Different statements is necessary but not sufficient evidence of different
  // accounts; without both numbers the pair stays unproven.
  const unknown = side({ transactionId: "in-3", credit: 50000, runId: "run-other", accountNumber: null });
  const [candidate] = findTransferCandidates([OUT, unknown]);
  assert.equal(candidate.strength, "possible");
  assert.ok(candidate.evidence.some((line) => /account number is unknown/i.test(line)));
});

test("direction must be opposite", () => {
  // Two debits are two payments, however alike.
  const otherDebit = side({ transactionId: "out-2", debit: 50000, runId: "run-savings", accountNumber: "2002" });
  assert.equal(findTransferCandidates([OUT, otherDebit]).length, 0);
});

test("the date window is enforced", () => {
  const justInside = side({ ...IN, transactionId: "in-inside", date: "2025-04-15" });
  const justOutside = side({ ...IN, transactionId: "in-outside", date: "2025-04-16" });
  assert.equal(findTransferCandidates([OUT, justInside]).length, 1, `${MAX_TRANSFER_DAY_GAP} days must qualify`);
  assert.equal(findTransferCandidates([OUT, justOutside]).length, 0, "beyond the window is coincidence");
});

test("a gap inside the window but over the strong limit stays possible", () => {
  const fourDays = side({ ...IN, transactionId: "in-4d", date: "2025-04-14" });
  const [candidate] = findTransferCandidates([OUT, fourDays]);
  assert.equal(candidate.strength, "possible");
});

test("a small difference is allowed as possible, a large one not at all", () => {
  // A transfer fee deducted in flight is real; a materially different amount is
  // a different transaction.
  const withFee = side({ ...IN, transactionId: "in-fee", credit: 49965 });
  const [feeCandidate] = findTransferCandidates([OUT, withFee]);
  assert.equal(feeCandidate.strength, "possible", "not exact, so not strong");
  assert.ok(feeCandidate.amountDelta > 0);

  const unrelated = side({ ...IN, transactionId: "in-far", credit: 47000 });
  assert.equal(findTransferCandidates([OUT, unrelated]).length, 0);
});

test("transfer wording alone never promotes a pair", () => {
  // "IB TRANSFER TO" appears on plenty of genuine payments to third parties.
  const wordedButInexact = side({ ...IN, transactionId: "in-word", credit: 49970, description: "IB TRANSFER FROM CURRENT" });
  const [candidate] = findTransferCandidates([OUT, wordedButInexact]);
  assert.equal(candidate.strength, "possible");
  assert.ok(candidate.evidence.some((line) => /mentions a transfer/i.test(line)));
});

test("already-decided transactions are not offered again", () => {
  assert.equal(findTransferCandidates([OUT, IN], new Set(["out-1"])).length, 0);
  assert.equal(findTransferCandidates([OUT, IN], new Set(["in-1"])).length, 0);
});

test("one payment cannot be three transfers", () => {
  // The accounting failure this prevents: confirming all three would remove
  // three times the money that actually moved.
  const credits = ["a", "b", "c"].map((suffix, i) =>
    side({ transactionId: `in-${suffix}`, credit: 50000, runId: `run-${suffix}`, accountNumber: `300${i}` }),
  );
  const all = findTransferCandidates([OUT, ...credits]);
  assert.equal(all.length, 3, "all three are surfaced as candidates");

  const best = bestTransferCandidates(all);
  assert.equal(best.length, 1, "only one may be acted on");
  assert.equal(best[0].outbound.transactionId, "out-1");
});

test("strong candidates outrank possible ones", () => {
  const weak = side({ transactionId: "in-weak", credit: 49980, runId: "run-w", accountNumber: "4004", date: "2025-04-14" });
  const strong = side({ transactionId: "in-strong", credit: 50000, runId: "run-s", accountNumber: "5005" });
  const ranked = findTransferCandidates([OUT, weak, strong]);
  assert.equal(ranked[0].inbound.transactionId, "in-strong");
  assert.equal(ranked[0].strength, "strong");
});

test("missing dates are skipped rather than guessed", () => {
  const undated = side({ ...IN, transactionId: "in-undated", date: null });
  assert.equal(findTransferCandidates([OUT, undated]).length, 0);
});

test("nothing in this module confirms anything", () => {
  // The output is evidence for a person, not a decision. Every candidate must
  // carry its reasons so the accountant can disagree.
  const [candidate] = findTransferCandidates([OUT, IN]);
  assert.ok(Array.isArray(candidate.evidence) && candidate.evidence.length >= 3);
  assert.ok(!("confirmed" in candidate), "a candidate has no confirmed state");
});

test("the decisions migration stores decisions, is scoped, and is reversible", () => {
  const migration = readFileSync("supabase/migrations/032_accounting_transfer_matches.sql", "utf8");
  assert.ok(/create table if not exists public\.accounting_transfer_matches/.test(migration));
  assert.ok(/workspace_id uuid not null references public\.workspaces/.test(migration), "workspace scoping");
  assert.ok(/enable row level security/.test(migration), "RLS enabled");
  assert.ok(/create policy .* on public\.accounting_transfer_matches/.test(migration), "RLS policy");

  // A rejection must be storable: without it the same wrong pair is re-offered
  // after every reprocess.
  assert.ok(/check \(status in \('confirmed', 'rejected'\)\)/.test(migration), "rejections are recorded too");

  // One decision per pair, so re-deciding cannot accumulate contradictions.
  assert.ok(/create unique index[\s\S]*outbound_transaction_id, inbound_transaction_id/.test(migration));

  // A transaction cannot be transferred to itself.
  assert.ok(/outbound_transaction_id <> inbound_transaction_id/.test(migration));

  // Decisions disappear with the transactions they describe.
  assert.ok(/on delete cascade/.test(migration));

  // Who and when — a transfer decision changes reported profit, so it is not
  // anonymous.
  assert.ok(/decided_by uuid references auth\.users/.test(migration));
  assert.ok(/decided_at timestamptz not null/.test(migration));
});

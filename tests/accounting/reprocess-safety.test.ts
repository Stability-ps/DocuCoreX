import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A reprocess must never destroy the ledger it is replacing.
 *
 * The route used to delete every transaction on the run before handing off to a
 * worker that takes about eleven minutes on a 37-page statement. For those
 * eleven minutes the run had no ledger, and any failure in them — worker
 * timeout, model outage, Render cold start, a deploy landing mid-flight, an
 * extraction fault — left it that way permanently. failRun marks the run
 * failed; it does not put 615 transactions back.
 *
 * The delete was also unnecessary. The worker clears the run's transactions
 * immediately before inserting the replacement, AFTER every extraction,
 * classification and validation stage has succeeded. Reprocessing was already
 * idempotent without it.
 *
 * These assertions are made against the route SOURCE rather than by driving the
 * handler. Reaching the deleted code required an authenticated workspace
 * context, a Supabase client, a run detail and Next's `after()` — four things
 * that would have to be faked, and a test built on four fakes mostly proves the
 * fakes agree with each other. The invariant is not "this behaves correctly
 * under mocks", it is "this destructive call does not exist", and that is
 * exactly what is checked here.
 */

const ROUTE = "app/api/accounting/fnb/process/route.ts";
const source = readFileSync(new URL(`../../${ROUTE}`, import.meta.url), "utf8");

/** Statements in the route, with comments and string literals left intact. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const code = withoutComments(source);

test("the reprocess route never deletes the transactions it is replacing", () => {
  assert.equal(
    code.includes('from("accounting_transactions")'),
    false,
    "the process route must not touch accounting_transactions at all — the worker owns that table, " +
      "and it replaces the ledger only after every validation has passed",
  );
});

test("no delete of any kind survives in the route", () => {
  // Belt and braces: catches a delete reintroduced through a variable table
  // name, a helper, or a differently-quoted string.
  const deleteCalls = code.match(/\.delete\s*\(/g) ?? [];
  assert.deepEqual(
    deleteCalls,
    [],
    `the route performs ${deleteCalls.length} delete(s); a reprocess must not remove anything before its replacement exists`,
  );
});

test("a reprocess does not advertise zero transactions while the old ledger is still there", () => {
  // The run kept 615 rows but reported transaction_count 0 and a null workbook
  // path, so a reviewer refreshing mid-reprocess saw an empty statement that
  // was not empty — and a failed run stayed that way.
  assert.equal(
    /transaction_count:\s*body\.reprocess\s*\?\s*0/.test(code),
    false,
    "transaction_count must not be zeroed on reprocess while the transactions are still stored",
  );
  assert.equal(
    /workbook_storage_path:\s*body\.reprocess\s*\?\s*null/.test(code),
    false,
    "workbook_storage_path must not be cleared on reprocess before a replacement export exists",
  );
});

test("the previous generation is carried forward, not reset", () => {
  assert.equal(
    code.includes("transaction_count: detail.run.transactionCount"),
    true,
    "the run keeps the count it actually has until a new ledger replaces it",
  );
  assert.equal(
    code.includes("workbook_storage_path: detail.run.workbookStoragePath"),
    true,
    "the run keeps its existing export until a new one is generated",
  );
});

test("reprocess still forces a fresh extraction and still bypasses duplicate-job protection", () => {
  // The flag has two legitimate jobs, and removing the delete must not have
  // quietly removed either: without the first, a reprocess would replay the
  // cached extraction and change nothing; without the second, a run stuck in
  // 'processing' could never be recovered.
  assert.match(
    code,
    /processStatementInBackground\([^)]*Boolean\(body\.reprocess\)\)/,
    "reprocess must still bypass the extraction cache",
  );
  assert.match(
    code,
    /status === "processing" && !body\.reprocess/,
    "reprocess must still be allowed to restart a run that is already processing",
  );
});

test("the run is marked processing so the UI can show progress without hiding the statement", () => {
  assert.equal(
    code.includes('status: "processing"'),
    true,
    "the UI's Reprocessing state is driven by run status, not by emptying the ledger",
  );
});

/** The worker delegates the only destructive step to the ownership-aware RPC. */
test("the worker replaces the ledger only through the owned atomic write", () => {
  const worker = readFileSync(new URL("../../workers/accounting_worker/main.py", import.meta.url), "utf8");
  const replace = worker.slice(worker.indexOf("def replace_transactions"), worker.indexOf("def insert_transactions"));
  assert.match(replace, /replace_accounting_transactions_owned/);
  assert.doesNotMatch(replace, /\.delete\(\)/, "the client must never delete outside the owned transaction");
  assert.match(worker, /provenance_persisted = replace_transactions\(/);
});

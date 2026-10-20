// Information exposure, accounting pass: the ~40 routes under
// app/api/accounting answered every catch with `error.message`, and the
// shared errorResponse helper did the same. Most of what reached them was
// PostgREST text thrown on from lib/accounting (table, column, constraint and
// RLS policy names), and the combine route returned the worker's raw body and
// address. Deliberate messages — validation, not found, and the posting rules
// the database words for the accountant — must still arrive unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { errorResponse } = await import("../../lib/api-auth.ts");
const { routeErrorResponse } = await import("../../lib/api-errors.ts");
const { UserFacingError, isUserFacingError } = await import("../../lib/user-facing-error.ts");
const { accountingDbError, notFoundError, businessRuleError, forbiddenError, rowFailureMessage, APPROVED_BUSINESS_RULE_MESSAGES, APPROVED_NOT_FOUND_MESSAGES, isApprovedBusinessRuleMessage, isApprovedNotFoundMessage } = await import("../../lib/accounting/errors.ts");
const { combineWorkerFailure } = await import("../../lib/accounting/combine-failure.ts");

async function quietly<T>(run: () => T | Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

const RLS = 'new row violates row-level security policy for table "accounting_journals"';
const UNIQUE = 'duplicate key value violates unique constraint "accounting_accounts_company_id_code_key"';
const MISSING_RELATION = 'relation "public.accounting_postings_v2" does not exist';

// ── 1. errorResponse classification ──────────────────────────────────────────

test("errorResponse: a missing session is a 401 with the sign-in sentence", async () => {
  const response = errorResponse(new Error("Unauthorized"), "Unable to export workbook.");
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /sign in/i);
});

test("errorResponse: a UserFacingError keeps its message, status and code", async () => {
  for (const [error, status, code] of [
    [new UserFacingError("Upload a bank statement PDF."), 400, "VALIDATION_ERROR"],
    [notFoundError("Entity not found in this workspace."), 404, "NOT_FOUND"],
    [forbiddenError("Forbidden"), 403, "FORBIDDEN"],
    [businessRuleError("This asset has already been disposed."), 422, "BUSINESS_RULE"],
  ] as const) {
    const response = errorResponse(error, "fallback");
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: error.message, code });
  }
});

test("errorResponse: anything else is the fallback sentence, logged under the event", async () => {
  const { result, logged } = await quietly(() => errorResponse(new Error(MISSING_RELATION), "Unable to export workbook.", 500, "docucorex.accounting.export_failed"));
  assert.equal(result.status, 500);
  const body = await result.json();
  assert.deepEqual(body, { error: "Unable to export workbook.", code: "INTERNAL_ERROR" });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "docucorex.accounting.export_failed");
  assert.match(JSON.stringify(logged[0][1]), /accounting_postings_v2/, "the detail stays in the server log");

  const { result: nonError } = await quietly(() => errorResponse({ message: RLS }, "Unable to load", 400));
  assert.equal(nonError.status, 400);
  assert.doesNotMatch(JSON.stringify(await nonError.json()), /row-level|accounting_journals/);
});

// ── 2. Database errors from lib/accounting ───────────────────────────────────

// The restrict_violation texts the posting gate, period close, reconciliation
// and allocation RPCs raise (migrations 036+). Written for the accountant.
const BUSINESS_RULES = [
  "journal does not balance: debits 1500.00, credits 1400.00, difference 100.00",
  "the period containing 2026-01-31 is locked; reopen it or post to an open period",
  "cannot lock: 2 unposted journal(s) dated in this period; post or remove them first",
  "a reason is required to reopen a closed period",
  "this reconciliation is completed; reopen it before changing its items",
  "amount 500.00 exceeds the invoice's unallocated balance of 120.00",
  "the bill and payment belong to different entities",
  "a line posting to the accounts receivable control account must name a customer",
];

test("posting rules raised by the database reach the client unchanged as 422", async () => {
  for (const message of BUSINESS_RULES) {
    const error = accountingDbError({ code: "23001", message });
    assert.ok(isUserFacingError(error), message);
    const response = routeErrorResponse("docucorex.accounting.journals.post_failed", error, { message: "Unable to create the journal." });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: message, code: "BUSINESS_RULE" });
  }
});

test("restrict_violation from the append-only triggers is internal: it names the table", async () => {
  for (const message of [
    "accounting_postings is append-only: a posting cannot be changed once made. Reverse the journal or post an adjusting journal instead.",
    "accounting_journal_lines is append-only: a row cannot be delete once recorded.",
    "accounting_postings may only be written by accounting_post_journal. Create a journal and post it instead of inserting a posting directly.",
  ]) {
    const error = accountingDbError({ code: "23001", message });
    assert.ok(!isUserFacingError(error));
    const { result } = await quietly(() => routeErrorResponse("docucorex.accounting.journals.post_failed", error, { message: "Unable to create the journal." }));
    assert.equal(result.status, 500);
    assert.doesNotMatch(JSON.stringify(await result.json()), /accounting_|append-only/);
  }
});

test("access refusals, unique violations and unknown database errors carry no schema detail", async () => {
  const cases: Array<[{ code: string; message: string }, number]> = [
    [{ code: "42501", message: RLS }, 403],
    [{ code: "42501", message: "company access denied" }, 403],
    [{ code: "23505", message: UNIQUE }, 409],
    [{ code: "42P01", message: MISSING_RELATION }, 500],
    [{ code: "23514", message: 'new row for relation "accounting_accounts" violates check constraint "accounting_accounts_type_check"' }, 500],
    [{ code: "PGRST204", message: "Could not find the 'vat_default' column of 'accounting_accounts' in the schema cache" }, 500],
  ];
  for (const [dbError, status] of cases) {
    const { result } = await quietly(() => routeErrorResponse("docucorex.accounting.coa_import.post_failed", accountingDbError(dbError), { message: "Unable to process the import." }));
    assert.equal(result.status, status, dbError.message);
    assert.doesNotMatch(JSON.stringify(await result.json()), /accounting_|row-level|constraint|schema cache|relation/, dbError.message);
  }
});

test("not-found from an accounting RPC or a .single() read is a 404", async () => {
  const rpc = accountingDbError({ code: "P0002", message: "period 4f1c0a4e-0000-4000-8000-000000000000 not found" });
  assert.equal((rpc as InstanceType<typeof UserFacingError>).status, 404);
  assert.equal(rpc.message, "period 4f1c0a4e-0000-4000-8000-000000000000 not found");
  const single = accountingDbError({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
  assert.equal((single as InstanceType<typeof UserFacingError>).status, 404);
  assert.doesNotMatch(single.message, /JSON object/);
});

test("a failed row in a bulk import reports a deliberate message or the fallback, never database text", async () => {
  const { result: kept } = await quietly(() => rowFailureMessage("e", businessRuleError("the period containing 2026-01-31 is locked; reopen it or post to an open period"), "Unable to post this journal."));
  assert.match(kept, /period containing/);
  const { result: duplicate } = await quietly(() => rowFailureMessage("e", accountingDbError({ code: "23505", message: UNIQUE }), "Unable to save this account."));
  assert.equal(duplicate, "This record already exists.");
  const { result: hidden, logged } = await quietly(() => rowFailureMessage("docucorex.accounting.coa_import_row_failed", accountingDbError({ code: "42P01", message: MISSING_RELATION }), "Unable to save this account.", { rowNumber: 3 }));
  assert.equal(hidden, "Unable to save this account.");
  assert.equal(logged[0][0], "docucorex.accounting.coa_import_row_failed");
});

// ── 3. Combine: worker responses ─────────────────────────────────────────────

test("combine passes on the worker's own HTTPException sentences", () => {
  const plain = combineWorkerFailure(422, JSON.stringify({ detail: "Selected statements are not the same company, bank and account number." }));
  assert.equal(plain.error, "Selected statements are not the same company, bank and account number.");
  assert.equal(plain.httpStatus, 422);

  const review = combineWorkerFailure(
    422,
    JSON.stringify({ detail: { status: "review_required", message: "Continuity checks failed. Review required before combining.", continuity: [{ closing: 1000 }], allow_override: true } }),
  );
  assert.equal(review.status, "review_required");
  assert.equal(review.allowOverride, true);
  assert.equal(review.error, "Continuity checks failed. Review required before combining.");
  assert.ok(!("continuity" in review), "statement balances are not echoed back");
});

test("combine hides worker crashes, validation echoes, auth failures and non-JSON bodies", () => {
  const cases: Array<[number, string]> = [
    [500, "Traceback (most recent call last):\n  File \"/app/main.py\", line 5943\npostgrest.exceptions.APIError: relation accounting_statement_runs"],
    [422, JSON.stringify({ detail: [{ loc: ["body", "run_ids"], msg: "field required", input: { workspace_id: "w" } }], message: "Worker request validation failed." })],
    [401, JSON.stringify({ detail: "Invalid worker token." })],
    [422, "<html>Bad gateway at accounting-internal.onrender.com</html>"],
  ];
  for (const [status, body] of cases) {
    const failure = combineWorkerFailure(status, body);
    assert.equal(failure.httpStatus, 502, body);
    assert.equal(failure.passedThrough, false);
    assert.doesNotMatch(failure.error, /Traceback|accounting_|run_ids|token|onrender/);
  }
});

// ── 4. Behaviour of a real route with no backend ─────────────────────────────

test("an accounting route that fails unexpectedly answers with its generic sentence", async () => {
  const { GET } = await import("../../app/api/accounting/periods/route.ts");
  const { result } = await quietly(() => GET(new Request("http://localhost/api/accounting/periods?companyId=c1")));
  const body = await result.json();
  assert.ok(result.status === 500 || result.status === 401, `status ${result.status}`);
  assert.doesNotMatch(JSON.stringify(body), /Supabase|configured|cookies|relation/i);
  if (result.status === 500) assert.deepEqual(body, { error: "Unable to load periods.", code: "INTERNAL_ERROR" });
});

// ── 5. Static: no accounting route returns a raw error message ──────────────

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

/** Removes `<prefix>( ... )` calls, matching parentheses. */
function stripCalls(source: string, prefix: RegExp): string {
  let out = source;
  for (;;) {
    const match = prefix.exec(out);
    if (!match) return out;
    let depth = 0;
    let end = match.index + match[0].length - 1; // at the opening paren
    for (; end < out.length; end += 1) {
      if (out[end] === "(") depth += 1;
      else if (out[end] === ")" && --depth === 0) break;
    }
    out = out.slice(0, match.index) + out.slice(end + 1);
  }
}

function withoutCommentsAndLogs(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  out = stripCalls(out, /console\.(?:log|info|warn|error|debug)\(/);
  // Caught by the same file's catch-all, which logs it and answers generically.
  out = stripCalls(out, /throw new Error\(/);
  // A deliberate message is allowed through.
  out = out.replace(/isUserFacingError\((\w+)\)\s*\?\s*\1\.message/g, "");
  return out;
}

// Each remaining `.message` read in an accounting route, and why it never
// reaches a response body. A new one fails this test until it is either routed
// through routeErrorResponse/errorResponse or justified here.
const ALLOWED_MESSAGE_READS: Record<string, string[]> = {
  "app/api/accounting/fnb/process/route.ts": [
    // Assigned for the console.warn that follows; the returned warning is a fixed sentence.
    "const message = pipelineError instanceof Error ? pipelineError.message : String(pipelineError);",
    // A fixed sentence from lib/accounting/workerToken.ts.
    "const message = new WorkerTokenMissingError().message;",
    // Logged; the run is failed with the UserFacingError text or a generic sentence.
    "const cause = error instanceof Error ? error.message : String(error);",
    // Stored on processing_jobs.error, which lib/jobs/job-error.ts cleans on read.
    "error: fallbackMarkError.message,",
  ],
};

const ACCOUNTING_ROUTES = routeFiles(join(root, "app/api/accounting")).map((path) => relative(root, path)).sort();

test("the accounting route inventory is the one this test was written against", () => {
  assert.ok(ACCOUNTING_ROUTES.length >= 39, `found ${ACCOUNTING_ROUTES.length} routes`);
});

for (const route of ACCOUNTING_ROUTES) {
  test(`${route} returns no raw error.message`, () => {
    const source = read(route);
    assert.doesNotMatch(source, /error instanceof Error \? error\.message : "/, "the old catch-all pattern");
    assert.doesNotMatch(source, /function statusFor\(message/, "status must come from the error's class, not from sniffing its text");

    const stripped = withoutCommentsAndLogs(source);
    const allowed = ALLOWED_MESSAGE_READS[route] ?? [];
    const reads = stripped
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\b[\w$]+\??\.message\b/.test(line))
      .filter((line) => !allowed.includes(line));
    assert.deepEqual(reads, [], `${route} reads an error message outside a log call`);

    // A caught value is never put into a response as it is (String(error),
    // `{ error }`, `{ error: err }`, `detail: error`).
    for (const [, name] of stripped.matchAll(/catch\s*\(\s*(\w+)\s*\)/g)) {
      const echoed = new RegExp(`(?:String\\(${name}\\)|\\b(?:error|detail|cause|message):\\s*${name}\\b(?!\\.|\\s*(?:as|instanceof)))`);
      for (const call of stripped.match(/NextResponse\.json\([\s\S]*?\);/g) ?? []) {
        assert.doesNotMatch(call, echoed, `${route} returns the caught ${name} directly: ${call.slice(0, 120)}`);
      }
    }
  });
}

test("no accounting response carries the worker's address or raw body", () => {
  for (const route of ACCOUNTING_ROUTES) {
    const stripped = withoutCommentsAndLogs(read(route));
    for (const call of stripped.match(/NextResponse\.json\([\s\S]*?\);/g) ?? []) {
      assert.doesNotMatch(call, /\bworker(?:Url|Endpoint|RawBody|Detail)\b|resolvedAccountingWorkerUrl/, `${route}: ${call.slice(0, 120)}`);
    }
  }
});

// ── 6. Static: lib/accounting throws are classified ─────────────────────────

const ACCOUNTING_LIB = readdirSync(join(root, "lib/accounting"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `lib/accounting/${name}`)
  .concat("lib/accounting/engine/admin.ts");

test("lib/accounting never rethrows database text as a plain Error", () => {
  for (const file of ACCOUNTING_LIB) {
    const source = read(file);
    assert.doesNotMatch(source, /throw new Error\([\w.?]+\.message/, `${file}: use accountingDbError(error)`);
    // A plain Error is reserved for the two internal signals the route helpers
    // recognise: a missing session ("Unauthorized" → 401) and a missing backend.
    for (const [, message] of source.matchAll(/throw new Error\(("[^"]*"|`[^`]*`)/g)) {
      assert.ok(["\"Unauthorized\"", "\"Supabase is not configured\""].includes(message), `${file}: ${message} should be a UserFacingError`);
    }
  }
});

test("deliberate accounting messages keep their wording and get the right status", () => {
  const expectations: Array<[string, RegExp]> = [
    ["lib/accounting/journals-server.ts", /notFoundError\("Entity not found in this workspace\."\)/],
    ["lib/accounting/reconciliation-server.ts", /notFoundError\("Reconciliation not found\."\)/],
    ["lib/accounting/fixed-assets-server.ts", /notFoundError\("Fixed asset not found\."\)/],
    ["lib/accounting/fixed-assets-server.ts", /businessRuleError\("This asset has already been disposed\."\)/],
    ["lib/accounting/fixed-assets-server.ts", /businessRuleError\("An account is required for where the proceeds were received\."\)/],
    ["lib/accounting/server.ts", /notFoundError\("Transaction not found\."\)/],
    ["lib/accounting/server.ts", /new UserFacingError\("A transaction cannot be transferred to itself\."\)/],
    ["lib/accounting/server.ts", /new UserFacingError\("A merchant is required\."\)/],
    ["lib/accounting/server.ts", /new UserFacingError\("The engagement start date must not be after the end date\."\)/],
    ["lib/accounting/server.ts", /new UserFacingError\(rejection === "empty" \? "A tag cannot be empty\."/],
    ["lib/accounting/engine/admin.ts", /forbiddenError\("Forbidden"\)/],
    // The journal validator's own sentences, joined, as a 422.
    ["lib/accounting/journals-server.ts", /throw businessRuleError\(validation\.map\(/],
  ];
  for (const [file, pattern] of expectations) assert.match(read(file), pattern, `${file} ${pattern}`);
});


// Every person-readable rule the migrations raise must be on the allow-list, and
// nothing else under restrict_violation / no_data_found may reach the client.
function raisedMessages(errcode: string) {
  const dir = join(root, "supabase/migrations");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(/raise exception\s+'((?:[^']|'')*)'([\s\S]*?);/g)) {
      if (m[2].includes(errcode)) found.add(m[1].replace(/''/g, "'"));
    }
  }
  return found;
}

test("every restrict_violation the migrations raise is approved, or deliberately internal", () => {
  const internal = /append-only|may only be written by/;
  const approved = new Set<string>(APPROVED_BUSINESS_RULE_MESSAGES);
  for (const message of raisedMessages("restrict_violation")) {
    if (internal.test(message)) {
      assert.ok(!approved.has(message), `internal trigger text must not be approved: ${message}`);
      continue;
    }
    assert.ok(approved.has(message), `new business-rule message needs review and approval: ${message}`);
  }
});

test("every no_data_found the migrations raise is an approved not-found sentence", () => {
  const approved = new Set<string>(APPROVED_NOT_FOUND_MESSAGES);
  for (const message of raisedMessages("no_data_found")) assert.ok(approved.has(message), message);
});

test("only approved business-rule text reaches the client as 422", () => {
  for (const message of [
    "journal does not balance: debits 1000.00, credits 900.00, difference 100.00",
    "the period containing 2026-03-31 is locked; reopen it or post to an open period",
    "amount 250.00 exceeds the invoice's unallocated balance of 100.00",
  ]) {
    assert.ok(isApprovedBusinessRuleMessage(message), message);
    const error = accountingDbError({ code: "23001", message });
    assert.equal((error as { status?: number }).status, 422);
    assert.equal(error.message, message);
  }
  for (const message of [
    'new row for relation "accounting_journals" violates check constraint "journals_status_check"',
    "journal does not balance: debits (select secret from vault), credits 1, difference 1",
    "journal is already posted\nDETAIL: Key (id)=(abc)",
    "some future rule nobody reviewed",
  ]) {
    assert.ok(!isApprovedBusinessRuleMessage(message), message);
    const error = accountingDbError({ code: "23001", message });
    assert.notEqual((error as { status?: number }).status, 422, message);
  }
});

test("unapproved no_data_found text becomes the fixed not-found sentence", () => {
  assert.ok(isApprovedNotFoundMessage("journal 5f0c2a8e-0000-4000-8000-000000000001 not found"));
  assert.equal(accountingDbError({ code: "P0002", message: "journal 42 not found" }).message, "journal 42 not found");
  assert.equal(accountingDbError({ code: "P0002", message: 'relation "x" row missing' }).message, "This record was not found.");
});

// Information exposure, second pass (T-016): auth messages, route catch-alls,
// processing-job errors and accounting-run errors carry no database, Storage,
// provider or worker detail. Deliberate validation messages still get through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../accounting/alias-hook.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));

const root = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const { signInErrorResponse, signUpErrorResponse, passwordResetMessage, INVALID_CREDENTIALS_MESSAGE, PASSWORD_RESET_SENT_MESSAGE } = await import("../../lib/auth-errors.ts");
const { UserFacingError, isUserFacingError } = await import("../../lib/user-facing-error.ts");
const { routeErrorResponse } = await import("../../lib/api-errors.ts");
const { userSafeJobError, genericJobFailureMessage } = await import("../../lib/jobs/job-error.ts");
const { ConversionError } = await import("../../lib/document-conversion-engine.ts");
const { getWorkerError, normalizeWorkerFailure, workerStatusMessage, isNoTransactionsFailure } = await import("../../lib/accounting/workerFailure.ts");
const { validateUploadFiles } = await import("../../lib/server-documents.ts");
const { createInvoice } = await import("../../lib/invoices.ts");
const { createCompany } = await import("../../lib/companies.ts");

// The helpers log what they hide; keep the test output readable and let tests
// inspect what was logged.
function captureErrors<T>(run: () => T): { result: T; logged: unknown[][] } {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: run(), logged };
  } finally {
    console.error = original;
  }
}

const POSTGREST = 'duplicate key value violates unique constraint "invoices_workspace_id_invoice_number_key"';

// ── 1. Auth ──────────────────────────────────────────────────────────────────

test("sign-in gives one answer for an unknown address and a wrong password", () => {
  const unknown = signInErrorResponse({ status: 400, code: "user_not_found", message: "User not found" });
  const wrong = signInErrorResponse({ status: 400, code: "invalid_credentials", message: "Invalid login credentials" });
  assert.deepEqual(unknown, wrong);
  assert.equal(unknown.message, INVALID_CREDENTIALS_MESSAGE);
  assert.equal(unknown.status, 401);
  assert.equal(signInErrorResponse({ status: 500, message: "Database error querying schema" }).message, INVALID_CREDENTIALS_MESSAGE);
});

test("sign-in keeps the rate limit and the unconfirmed-address messages", () => {
  assert.equal(signInErrorResponse({ status: 429, code: "over_request_rate_limit" }).status, 429);
  assert.match(signInErrorResponse({ status: 400, code: "email_not_confirmed" }).message, /confirm your email/i);
});

test("sign-up keeps validation verdicts and hides unexpected Auth text", () => {
  assert.equal(signUpErrorResponse({ code: "weak_password", message: "Password should be at least 8 characters." }).message, "Password should be at least 8 characters.");
  assert.equal(signUpErrorResponse({ code: "email_address_invalid", message: "Email address \"x\" is invalid" }).message, "Enter a valid email address.");
  assert.equal(signUpErrorResponse({ status: 429, code: "over_email_send_rate_limit" }).status, 429);
  // A failing database trigger or SMTP relay.
  const unexpected = signUpErrorResponse({ status: 500, code: "unexpected_failure", message: "Database error saving new user" });
  assert.doesNotMatch(unexpected.message, /database/i);
  // Product decision, documented in lib/auth-errors.ts: still disclosed.
  assert.match(signUpErrorResponse({ code: "user_already_exists", message: "User already registered" }).message, /already exists/);
  assert.match(signUpErrorResponse({ status: 422, message: "User already registered" }).message, /already exists/, "older responses without a code");
});

test("password reset never says whether the address has an account", () => {
  assert.equal(passwordResetMessage(null), PASSWORD_RESET_SENT_MESSAGE);
  assert.match(PASSWORD_RESET_SENT_MESSAGE, /^If an account exists/);
  const failed = passwordResetMessage({ status: 500, message: "Error sending recovery email: smtp.internal:587 refused" });
  assert.doesNotMatch(failed, /smtp|587/);
  assert.match(passwordResetMessage({ status: 429 }), /too many/i);
});

test("the auth routes and the login page no longer return Auth's raw message", () => {
  for (const path of ["app/api/auth/signin/route.ts", "app/api/auth/signup/route.ts"]) {
    assert.doesNotMatch(read(path), /\{ error: error\.message \}/, path);
  }
  assert.match(read("app/api/auth/signin/route.ts"), /signInErrorResponse\(error\)/);
  assert.match(read("app/api/auth/signup/route.ts"), /signUpErrorResponse\(error\)/);
  const login = read("app/login/page.tsx");
  assert.doesNotMatch(login, /setStatus\(result\.error\.message\)/);
  assert.match(login, /passwordResetMessage\(result\.error\)/);
});

// ── 2/3. Route catch-alls: invoices, companies, uploads ──────────────────────

test("a UserFacingError reaches the client with its message and status", async () => {
  const response = routeErrorResponse("test.event", new UserFacingError("Client name is required."), { message: "Unable to create the invoice." });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Client name is required.", code: "VALIDATION_ERROR" });
});

test("an unexpected error is logged and answered generically", async () => {
  const { result: response, logged } = captureErrors(() =>
    routeErrorResponse("docucorex.invoices.create_failed", new Error(POSTGREST), { message: "Unable to create the invoice." }),
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "Unable to create the invoice.", code: "INTERNAL_ERROR" });
  assert.equal(logged[0][0], "docucorex.invoices.create_failed");
  assert.match(JSON.stringify(logged[0][1]), /invoices_workspace_id/, "the detail is in the server log");
});

test("a missing session is still a 401", async () => {
  const response = routeErrorResponse("test.event", new Error("Unauthorized"), { message: "x" });
  assert.equal(response.status, 401);
});

test("invoice, company and upload validation throws UserFacingError", async () => {
  await assert.rejects(createInvoice({ clientName: "Acme", lineItems: [] } as never), (error) => isUserFacingError(error));
  await assert.rejects(createInvoice({ clientName: " ", lineItems: [{ serviceItem: "Work", unitPrice: "10" }] } as never), (error) => isUserFacingError(error));
  await assert.rejects(createCompany({ businessName: " " } as never), (error) => isUserFacingError(error));
  assert.throws(() => validateUploadFiles([{ name: "evil.html", size: 10, type: "text/html" }]), (error) => isUserFacingError(error));
  assert.throws(() => validateUploadFiles([]), (error) => isUserFacingError(error));
});

test("invoice, company and upload routes have no raw error.message catch-all", () => {
  for (const path of [
    "app/api/invoices/route.ts",
    "app/api/companies/route.ts",
    "app/api/companies/[id]/route.ts",
    "app/api/uploads/route.ts",
    "app/api/uploads/signed-url/route.ts",
    "app/api/accounting/fnb/upload/route.ts",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /error instanceof Error \? error\.message/, path);
    assert.match(source, /routeErrorResponse\(/, path);
  }
  // The file-signature verdict is deliberate and must keep its wording.
  assert.match(read("app/api/uploads/route.ts"), /throw new UserFacingError\(signature\.reason\)/);
});

// ── 4. processing_jobs.error ────────────────────────────────────────────────

test("a job keeps a deliberate failure message", () => {
  assert.equal(userSafeJobError(new UserFacingError("No text could be read from this document."), "ocr"), "No text could be read from this document.");
  const conversion = new ConversionError("The PDF has no readable pages.", "PDF_HAS_NO_PAGES");
  assert.equal(userSafeJobError(conversion, "conversion"), "The PDF has no readable pages.");
});

test("a job stores a generic message instead of raw Storage or provider text", () => {
  const raw = new Error("Object not found: ws_123/documents/2026/payslip.pdf (StorageApiError 404)");
  const { result, logged } = captureErrors(() => userSafeJobError(raw, "conversion", { jobId: "j1" }));
  assert.equal(result, genericJobFailureMessage("conversion"));
  assert.doesNotMatch(result, /ws_123|payslip|Storage/);
  assert.equal(logged[0][0], "docucorex.job.failed");
  assert.match(JSON.stringify(logged[0][1]), /payslip\.pdf/);
  assert.equal(captureErrors(() => userSafeJobError(new Error("x"), "ocr")).result, "Text recognition failed. Please try again.");
  assert.equal(captureErrors(() => userSafeJobError("boom", "something-new")).result, "Processing failed. Please try again.");
});

test("job failure writers go through userSafeJobError", () => {
  const process = read("app/api/jobs/process/route.ts");
  assert.match(process, /const message = userSafeJobError\(error, job\.type/);
  assert.doesNotMatch(process, /Converted file upload failed: \$\{/);
  assert.doesNotMatch(process, /download access could not be verified: \$\{reason\}/);
  // The conversion id marker the poller and getConversionIdFromMessage rely on
  // is still appended to the stored message.
  assert.match(process, /message: internalJobMessage\(message,/);
  const asyncJobs = read("lib/ocr/asyncJobs.ts");
  assert.doesNotMatch(asyncJobs, /error instanceof Error \? error\.message/);
  assert.match(asyncJobs, /userSafeJobError\(error, "ocr"/);
  assert.match(asyncJobs, /userSafeJobError\(error, "extraction"/);
});

test("conversion tool output (stderr, Tesseract's stdout) is not put in a ConversionError message", () => {
  const engine = read("lib/document-conversion-engine.ts");
  assert.doesNotMatch(engine, /new ConversionError\(`[^`]*\$\{reason/);
  const logger = engine.slice(engine.indexOf("function logToolFailure"), engine.indexOf("export type SourceDocument"));
  assert.ok(logger.length > 0);
  assert.doesNotMatch(logger, /stdout/, "stdout can be the document's text and is not logged");
  assert.equal((engine.match(/logToolFailure\("[a-z]+", result\)/g) ?? []).length, 4);
});

test("the accounting worker stores a fixed sentence for an unexpected exception", () => {
  const worker = read("workers/accounting_worker/main.py");
  const block = worker.slice(worker.indexOf("    except Exception as exc:\n        # Unexpected, unlike the HTTPException"));
  assert.ok(block.length > 0);
  const handler = block.slice(0, block.indexOf("raise HTTPException"));
  assert.match(handler, /message = "Statement processing failed unexpectedly/);
  assert.match(handler, /error=detail/, "the detail is logged");
  assert.doesNotMatch(worker, /raise HTTPException\(status_code=422, detail=str\(exc\)\)/);
});

// ── 5. Accounting run errors ────────────────────────────────────────────────

test("a non-JSON worker error body is reduced to its status", () => {
  const message = getWorkerError(null, 502);
  assert.equal(message, workerStatusMessage(502));
  assert.match(message, /HTTP 502/);
  assert.equal(normalizeWorkerFailure({ status: 502, message }), message);
  assert.match(getWorkerError(null, 500), /HTTP 500/);
  assert.match(getWorkerError(null, 400), /HTTP 400/);
});

test("a non-JSON 404 is still reported as a misconfigured endpoint, without the URL", () => {
  const error = normalizeWorkerFailure({ status: 404, message: getWorkerError(null, 404) });
  assert.match(error, /endpoint not found/);
  assert.doesNotMatch(error, /https?:|onrender|current:/);
  assert.equal(isNoTransactionsFailure(404, error), false);
});

test("the worker's own JSON verdicts are kept", () => {
  assert.equal(getWorkerError({ detail: "No FNB transactions could be parsed." }, 422), "No FNB transactions could be parsed.");
  assert.equal(getWorkerError({ error: "Statement is password protected." }, 400), "Statement is password protected.");
  assert.match(normalizeWorkerFailure({ status: 401, message: "Invalid credentials." }), /Worker said: Invalid credentials\./);
  assert.doesNotMatch(normalizeWorkerFailure({ status: 500, message: "boom" }), /endpoint/);
});

test("the process route no longer copies the response text, endpoint or worker metadata into the run", () => {
  const route = read("app/api/accounting/fnb/process/route.ts");
  assert.doesNotMatch(route, /responseText\.slice\(/);
  assert.doesNotMatch(route, /result = \{ detail: responseText \}/);
  assert.doesNotMatch(route, /\(endpoint: \$\{/);
  assert.doesNotMatch(route, /Accounting worker unreachable: \$\{/);
  assert.match(route, /bodyLength: responseText\.length/, "status and length are logged instead");
  assert.match(route, /getWorkerError\(result, response\.status\)/);
});

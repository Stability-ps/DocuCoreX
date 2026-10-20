// Classifies accounting failures into what a person may read and what only the
// server log may hold.
//
// The accounting routes used to answer every catch with `error.message`, and
// most of what reached them was PostgREST text thrown on from these lib
// modules: table, column, constraint and RLS policy names. Throws written for
// people are now UserFacingErrors carrying the HTTP status they mean; database
// errors go through accountingDbError, which keeps only the posting rules the
// database itself words for the accountant (migrations 036+: unbalanced
// journal, closed period, completed reconciliation, over-allocation).
//
// Kept free of next/server so lib modules and unit tests can import it.

import { UserFacingError } from "@/lib/user-facing-error";

/** A record that is absent, or not in the caller's workspace (the two are not told apart). */
export function notFoundError(message: string) {
  return new UserFacingError(message, { status: 404, code: "NOT_FOUND" });
}

/** The caller is signed in but not allowed to do this. */
export function forbiddenError(message: string) {
  return new UserFacingError(message, { status: 403, code: "FORBIDDEN" });
}

/** A well-formed request an accounting rule refuses: closed period, unbalanced journal, disposed asset. */
export function businessRuleError(message: string) {
  return new UserFacingError(message, { status: 422, code: "BUSINESS_RULE" });
}

type DatabaseErrorLike = { message?: string | null; code?: string | null };

// SQLSTATEs as PostgREST reports them.
const RESTRICT_VIOLATION = "23001"; // `raise exception ... using errcode = 'restrict_violation'`
const UNIQUE_VIOLATION = "23505";
const NO_DATA_FOUND = "P0002"; // `using errcode = 'no_data_found'`
const INSUFFICIENT_PRIVILEGE = "42501"; // explicit access checks, and RLS refusals
const NO_SINGLE_ROW = "PGRST116"; // .single() matched no row (or several)

// The posting rules the migrations raise for people (restrict_violation and
// no_data_found), as an allow-list: only these reach the client. `%` marks a
// value the database fills in (an amount, a date, a status, an id), which is
// always the caller's own. Any other text under those codes (the append-only
// and write-path triggers name tables; a future migration might say anything)
// is treated as internal. Keep in step with supabase/migrations; the test
// suite checks every such raise in the migrations against this list.
export const APPROVED_BUSINESS_RULE_MESSAGES = [
  "% item(s) are missing from the ledger and have no correcting journal. A missing posting is an accounting error, not a reconciling item.",
  "a journal of zero cannot be posted",
  "a journal with no lines cannot be posted",
  "a line posting to the accounts payable control account must name a supplier",
  "a line posting to the accounts receivable control account must name a customer",
  "a reason is required to reopen a closed period",
  "a reversed journal cannot be posted again",
  "allocation amount must be positive",
  "amount % exceeds the bill's unallocated balance of %",
  "amount % exceeds the invoice's unallocated balance of %",
  "amount % exceeds the payment's unallocated balance of %",
  "amount % exceeds the receipt's unallocated balance of %",
  "both postings must be to the entity's accounts payable control account",
  "both postings must be to the entity's accounts receivable control account",
  "cannot lock: % unposted journal(s) dated in this period; post or remove them first",
  "journal does not balance: debits %, credits %, difference %",
  "journal is already posted",
  "journal lines cannot be changed once the journal is %",
  "only a posted journal can be reversed (this one is %)",
  "period_start must not be after period_end",
  "status must be soft_closed or locked",
  "the VAT period containing % is locked; a VAT-bearing journal cannot be posted into a filed period",
  "the bill and payment belong to different entities",
  "the bill and payment must name the same supplier",
  "the bill posting must be a credit to the control account",
  "the invoice and receipt belong to different entities",
  "the invoice and receipt must name the same customer",
  "the invoice posting must be a debit to the control account",
  "the payment posting must be a debit to the control account",
  "the period containing % is %; reopen it or post to an open period",
  "the receipt posting must be a credit to the control account",
  "the reconciliation does not explain the difference. Statement %, reconciling items % / %, ledger %, unexplained %.",
  "this reconciliation is already completed",
  "this reconciliation is completed; reopen it before changing its items",
] as const;

export const APPROVED_NOT_FOUND_MESSAGES = [
  "bill posting % not found",
  "company % not found",
  "invoice posting % not found",
  "journal % not found",
  "payment posting % not found",
  "period % not found",
  "receipt posting % not found",
  "reconciliation % not found",
] as const;

// A filled-in value: a number, date, status word or id. Never free text with
// quotes, parentheses or line breaks.
const PLACEHOLDER = "[-\\w.,: ]{1,64}";

function templatePattern(templates: readonly string[]) {
  const alternatives = templates.map((t) => t.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(PLACEHOLDER));
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

const APPROVED_BUSINESS_RULE = templatePattern(APPROVED_BUSINESS_RULE_MESSAGES);
const APPROVED_NOT_FOUND = templatePattern(APPROVED_NOT_FOUND_MESSAGES);

/** Whether a database message is one of the approved, person-readable posting rules. */
export function isApprovedBusinessRuleMessage(message: string) {
  return APPROVED_BUSINESS_RULE.test(message);
}

/** Whether a database message is one of the approved `<thing> <id> not found` sentences. */
export function isApprovedNotFoundMessage(message: string) {
  return APPROVED_NOT_FOUND.test(message);
}

/**
 * The Error to throw for a failed Supabase/PostgREST call in an accounting lib
 * module.
 *
 * - An approved posting rule (restrict_violation matching
 *   APPROVED_BUSINESS_RULE_MESSAGES) → 422, message unchanged.
 * - An approved `<thing> <id> not found` (no_data_found) → 404, message
 *   unchanged; it echoes only the id the caller sent. Unapproved text under
 *   either code is internal.
 * - `.single()` matching no row (PGRST116) → 404 with a fixed sentence: the
 *   update or read targeted a record outside the caller's workspace or gone.
 * - An access refusal (42501) → 403 with a fixed sentence: RLS refusals name
 *   the table.
 * - A unique violation → 409 with a fixed sentence: the text names the
 *   constraint and echoes the conflicting value.
 * - Anything else → a plain Error. Its message is the database text, which the
 *   route catch-all logs and replaces with a generic sentence.
 */
export function accountingDbError(error: DatabaseErrorLike): Error {
  const message = error.message ?? "Database request failed.";
  switch (error.code) {
    case RESTRICT_VIOLATION:
      return isApprovedBusinessRuleMessage(message) ? businessRuleError(message) : new Error(message);
    case NO_DATA_FOUND:
      return isApprovedNotFoundMessage(message) ? notFoundError(message) : notFoundError("This record was not found.");
    case NO_SINGLE_ROW:
      return notFoundError("This record was not found.");
    case INSUFFICIENT_PRIVILEGE:
      return forbiddenError("You do not have access to this record.");
    case UNIQUE_VIOLATION:
      return new UserFacingError("This record already exists.", { status: 409, code: "DUPLICATE" });
    default:
      return new Error(message);
  }
}

/**
 * The text to report for one failed row of a bulk operation (CSV import,
 * depreciation run) whose overall response still succeeds. Deliberate messages
 * are kept; anything else is logged under `event` and replaced with `fallback`.
 */
export function rowFailureMessage(event: string, error: unknown, fallback: string, context: Record<string, unknown> = {}): string {
  if (error instanceof UserFacingError) return error.message;
  console.error(event, {
    ...context,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  return fallback;
}

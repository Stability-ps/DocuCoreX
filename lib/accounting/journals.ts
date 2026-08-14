/**
 * Journal types and the balance rules, in a module with NO server imports.
 *
 * Separated from journals-server.ts so the browser and the tests can use them.
 * Stage 3 learned this the hard way: a client component importing a type from a
 * module that also imported getWorkspaceContext pulled `next/headers` into the
 * browser bundle and broke the build.
 *
 * These rules are NOT the control. The control is in the database
 * (accounting_post_journal, migration 036). This exists so the accountant sees
 * what is wrong before submitting, rather than as a rejected request. If the two
 * ever disagree, the database is right and this is the bug.
 */

export type JournalStatus = "draft" | "pending_review" | "approved" | "posted" | "reversed";

export type JournalType =
  | "general"
  | "adjustment"
  | "opening_balance"
  | "depreciation"
  | "disposal"
  | "accrual"
  | "prepayment"
  | "tax"
  | "closing"
  | "reversal";

export type JournalLineInput = {
  accountId: string;
  debit: number;
  credit: number;
  description?: string | null;
  /** The tax code the accountant assigned. Null is "no VAT arises here". */
  taxCodeId?: string | null;
  /** Required by the posting gate when accountId is the entity's AR control account. */
  customerId?: string | null;
  /** Required by the posting gate when accountId is the entity's AP control account. */
  supplierId?: string | null;
};

export type JournalSummary = {
  id: string;
  companyId: string;
  journalType: JournalType;
  reference: string | null;
  journalDate: string;
  description: string | null;
  status: JournalStatus;
  reversesJournalId: string | null;
  totalDebit: number;
  totalCredit: number;
  lineCount: number;
  postedAt: string | null;
  createdAt: string;
};

/** Cents, as an integer, so summing never accumulates binary-float error. */
function cents(value: number): number {
  return Math.round(value * 100);
}

export type JournalValidationError = { line?: number; message: string };

/**
 * The same rules the database enforces, evaluated early so the user sees them
 * as guidance rather than as a rejected request.
 */
export function validateJournalLines(lines: JournalLineInput[]): JournalValidationError[] {
  const errors: JournalValidationError[] = [];

  if (!lines.length) {
    errors.push({ message: "A journal needs at least one line." });
    return errors;
  }

  lines.forEach((line, index) => {
    const number = index + 1;
    if (!line.accountId) {
      errors.push({ line: number, message: "Choose an account." });
    }
    if (line.debit < 0 || line.credit < 0) {
      errors.push({ line: number, message: "Amounts are magnitudes; use the other column instead of a negative." });
    }
    const hasDebit = cents(line.debit) > 0;
    const hasCredit = cents(line.credit) > 0;
    if (hasDebit && hasCredit) {
      errors.push({ line: number, message: "A line is either a debit or a credit, not both." });
    }
    if (!hasDebit && !hasCredit) {
      errors.push({ line: number, message: "Enter a debit or a credit." });
    }
  });

  const debit = lines.reduce((total, line) => total + cents(line.debit), 0);
  const credit = lines.reduce((total, line) => total + cents(line.credit), 0);

  if (debit !== credit) {
    const difference = Math.abs(debit - credit) / 100;
    errors.push({
      message: `Journal does not balance. Debits ${(debit / 100).toFixed(2)}, credits ${(credit / 100).toFixed(2)}, difference ${difference.toFixed(2)}.`,
    });
  } else if (debit === 0) {
    errors.push({ message: "A journal of zero cannot be posted." });
  }

  return errors;
}

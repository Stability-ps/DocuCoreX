import type { AccountingStatementRun } from "@/lib/accounting/types";

// Derive a statement's display name and sort month from the STATEMENT's own
// metadata (period end / statement date) — NEVER the upload or current date.
//
// Order: statement period END → statement date → statement period START.
// Before the statement has been processed (no date extracted yet) we show a
// neutral placeholder instead of guessing a month from the upload date.

type NamingRun = Pick<AccountingStatementRun, "statementPeriodEnd" | "statementPeriodStart" | "companyName"> & {
  statementDate?: string | null;
  status?: AccountingStatementRun["status"];
};

// The date that represents the statement's month, as an ISO string, or null.
// Deliberately excludes the upload date — the month must come from the PDF.
export function statementReferenceDate(run: NamingRun): string | null {
  const candidates = [run.statementPeriodEnd, run.statementDate, run.statementPeriodStart];
  for (const candidate of candidates) {
    if (candidate && !Number.isNaN(new Date(candidate).getTime())) return candidate;
  }
  return null;
}

function monthYear(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Format in UTC so an end-of-month date (e.g. 2026-03-31) never shifts month
  // across a timezone boundary.
  return date.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Neutral placeholder shown before a statement date has been extracted — never a
// guessed month, never the upload date.
export function statementPlaceholderName(run: NamingRun): string {
  if (run.status === "queued" || run.status === "processing") return "Processing Statement…";
  if (run.status === "failed") return "Statement (Processing Failed)";
  if (run.companyName?.trim()) return `${run.companyName.trim()} Statement`;
  return "Statement (Awaiting Processing)";
}

// "March 2026 Statement" once the period/date is known; a neutral placeholder
// before then.
export function statementDisplayName(run: NamingRun): string {
  const reference = statementReferenceDate(run);
  const label = reference ? monthYear(reference) : null;
  if (label) return `${label} Statement`;
  return statementPlaceholderName(run);
}

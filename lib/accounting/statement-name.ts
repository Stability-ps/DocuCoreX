import type { AccountingStatementRun } from "@/lib/accounting/types";

// Derive a statement's display name and sort month from the STATEMENT's own
// metadata (period end / statement date) — never the upload or current date,
// unless no statement date can be determined.
//
// Order: statement period END → statement date → statement period START →
// (last resort) upload date.

type NamingRun = Pick<AccountingStatementRun, "statementPeriodEnd" | "statementPeriodStart" | "createdAt" | "companyName"> & {
  statementDate?: string | null;
};

// The best available date to represent the statement's month, as an ISO string,
// or null. Excludes the upload date unless it is the only thing available.
export function statementReferenceDate(run: NamingRun): string | null {
  const candidates = [run.statementPeriodEnd, run.statementDate, run.statementPeriodStart];
  for (const candidate of candidates) {
    if (candidate && !Number.isNaN(new Date(candidate).getTime())) return candidate;
  }
  // Only fall back to the upload date when the statement carries no date at all.
  if (run.createdAt && !Number.isNaN(new Date(run.createdAt).getTime())) return run.createdAt;
  return null;
}

function monthYear(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Format in UTC so an end-of-month date (e.g. 2026-03-31) never shifts month
  // across a timezone boundary.
  return date.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
}

// "March 2026 Statement" for a 31 March 2026 statement — from the PDF period end,
// never the July upload date.
export function statementDisplayName(run: NamingRun): string {
  const reference = statementReferenceDate(run);
  const label = reference ? monthYear(reference) : null;
  if (label) return `${label} Statement`;
  return run.companyName ? `${run.companyName} Statement` : "Bank Statement";
}

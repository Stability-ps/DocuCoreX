import { NextResponse } from "next/server";
import { getTrialBalance } from "@/lib/accounting/ledger-server";
import { toCsv, trialBalanceTotals } from "@/lib/accounting/ledger";

/**
 * Trial Balance, aggregated from postings by the database.
 *
 * `includeAdjustments=false` gives the UNADJUSTED trial balance from the same
 * ledger — adjustments are journals, so excluding them is a filter, not a
 * second stored balance set that could disagree.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });

  const input = {
    companyId,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    includeAdjustments: url.searchParams.get("includeAdjustments") !== "false",
  };

  try {
    const rows = await getTrialBalance(input);
    const totals = trialBalanceTotals(rows);

    if (url.searchParams.get("format") === "csv") {
      const csv = toCsv(
        ["Account code", "Account name", "Type", "Debits", "Credits", "Closing balance"],
        [
          ...rows.map((row) => [row.code, row.name, row.accountType, row.debits, row.credits, row.closingBalance]),
          [],
          ["", "Total", "", totals.totalDebits, totals.totalCredits, ""],
          ["", "Difference", "", totals.difference, "", totals.balanced ? "BALANCED" : "OUT OF BALANCE"],
        ],
      );
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="trial-balance.csv"`,
        },
      });
    }

    return NextResponse.json({ rows, totals });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the trial balance.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

import { NextResponse } from "next/server";
import { getAccountOpeningBalance, getGeneralLedger } from "@/lib/accounting/ledger-server";
import { toCsv, formatLedgerDate } from "@/lib/accounting/ledger";

/**
 * General Ledger. Entity-scoped by construction — companyId is required, never
 * defaulted, so a ledger is never served for "whichever entity came first".
 *
 * `format=csv` exports the CURRENT FILTERS rather than everything, because an
 * export that ignores the filters is not the report the accountant is looking at.
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

  const filters = {
    companyId,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    accountId: url.searchParams.get("accountId"),
    accountType: url.searchParams.get("accountType"),
    journalType: url.searchParams.get("journalType"),
    search: url.searchParams.get("search"),
    limit: Number(url.searchParams.get("limit") ?? 100),
    offset: Number(url.searchParams.get("offset") ?? 0),
  };

  try {
    if (url.searchParams.get("format") === "csv") {
      // Export the whole filtered set, not the visible page.
      const { rows } = await getGeneralLedger({ ...filters, limit: 500, offset: 0 });
      const csv = toCsv(
        ["Date", "Reference", "Account code", "Account", "Description", "Journal type", "Debit", "Credit", "Running balance"],
        rows.map((row) => [
          formatLedgerDate(row.postingDate),
          row.journalReference,
          row.accountCode,
          row.accountName,
          row.description,
          row.journalType,
          row.debit || null,
          row.credit || null,
          row.runningBalance,
        ]),
      );
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="general-ledger.csv"`,
        },
      });
    }

    const { rows, totalRows } = await getGeneralLedger(filters);
    const openingBalance = filters.accountId && filters.from
      ? await getAccountOpeningBalance(companyId, filters.accountId, filters.from)
      : null;

    return NextResponse.json({ rows, totalRows, openingBalance });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the general ledger.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

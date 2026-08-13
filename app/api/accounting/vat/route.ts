import { NextResponse } from "next/server";
import {
  countTransactionsAwaitingReview,
  getVatPeriod,
  getVatRegister,
  getVatSummary,
  listTaxCodes,
} from "@/lib/accounting/vat-server";
import { toCsv } from "@/lib/accounting/ledger";
import { vatPosition, vatReadiness } from "@/lib/accounting/vat";

/**
 * VAT, derived from postings.
 *
 * The response carries the readiness checks alongside the figures, because a
 * VAT position without them invites filing from numbers the system knows are
 * not final.
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

  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD." }, { status: 400 });
  }

  try {
    const [rows, register, taxCodes, period, awaitingReview] = await Promise.all([
      getVatSummary(companyId, from, to),
      getVatRegister(companyId, from, to),
      listTaxCodes(companyId),
      getVatPeriod(companyId, from, to),
      countTransactionsAwaitingReview(from, to),
    ]);

    const position = vatPosition(rows);
    const readiness = vatReadiness({
      rows,
      position,
      transactionsAwaitingReview: awaitingReview,
      periodLocked: period?.status === "locked",
    });

    if (url.searchParams.get("format") === "csv") {
      const csv = toCsv(
        ["Date", "Tax code", "Direction", "Account", "Description", "Reference", "Amount", "VAT leg"],
        register.rows.map((row) => [
          row.postingDate, row.code, row.direction,
          `${row.accountCode} ${row.accountName}`,
          row.description, row.journalReference, row.amount,
          row.isControlLeg ? "yes" : "no",
        ]),
      );
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="vat-schedule.csv"`,
        },
      });
    }

    return NextResponse.json({ rows, register: register.rows, totalRegisterRows: register.totalRows, taxCodes, period, position, readiness });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load VAT.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

import { NextResponse } from "next/server";
import { listAccountingEntities, listChartOfAccounts } from "@/lib/accounting/chart-server";
import { listTaxCodes } from "@/lib/accounting/vat-server";
import { listCustomers, listSuppliers } from "@/lib/accounting/receivables-payables-server";
import { toCsv } from "@/lib/accounting/ledger";

/**
 * The chart of accounts for one entity.
 *
 * Entity-scoped by construction: `companyId` is required rather than defaulted,
 * so a chart is never served for "whichever company came first". Company
 * isolation (§40) is the rule this route exists to keep — an accountant holding
 * several clients in one workspace must never see one client's chart while
 * looking at another.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  return 500;
}

export async function GET(request: Request) {
  const companyId = new URL(request.url).searchParams.get("companyId");

  try {
    const entities = await listAccountingEntities();

    if (!companyId) {
      // No entity chosen: return the entities so the caller can choose one.
      // Deliberately not "pick the default and return its chart" — that reads as
      // a chart for an entity the user did not select.
      return NextResponse.json({ entities, accounts: null, taxCodes: null, customers: null, suppliers: null });
    }

    if (new URL(request.url).searchParams.get("format") === "csv") {
      const accounts = await listChartOfAccounts(companyId);
      const idToCode = new Map(accounts.map((a) => [a.id, a.code]));
      const csv = toCsv(
        ["code", "name", "account_type", "normal_balance", "parent_code", "vat_default", "description"],
        accounts.map((a) => [a.code, a.name, a.accountType, a.normalBalance, a.parentId ? (idToCode.get(a.parentId) ?? "") : "", a.vatDefault, a.description]),
      );
      return new NextResponse(csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="chart-of-accounts.csv"` },
      });
    }

    // Tax codes, customers and suppliers all ride along: the journal form
    // needs all of them to offer a VAT split or an AR/AP party, and asking
    // separately would be a second and third round trip for data that is
    // always wanted together.
    const [accounts, taxCodes, customers, suppliers] = await Promise.all([
      listChartOfAccounts(companyId),
      listTaxCodes(companyId),
      listCustomers(companyId),
      listSuppliers(companyId),
    ]);
    return NextResponse.json({ entities, accounts, taxCodes, customers, suppliers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the chart of accounts.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

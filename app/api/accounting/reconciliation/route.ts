import { NextResponse } from "next/server";
import { toCsv } from "@/lib/accounting/ledger";
import {
  completeReconciliation,
  createBankAccountMapping,
  getOrCreateReconciliation,
  getReconciliationWorkspace,
  listBankAccounts,
  listMappableAccounts,
  listReconciliationHistory,
  recordReconciliationItems,
  removeReconciliationItem,
  reopenReconciliation,
} from "@/lib/accounting/reconciliation-server";

/**
 * Bank reconciliation.
 *
 * Completion is delegated to accounting_complete_reconciliation, which enforces
 * that the difference is EXPLAINED rather than merely zero. This route never
 * decides that a reconciliation may be signed off.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace." || message === "Reconciliation not found.") return 404;
  // A refused completion is the request being wrong, not the server failing.
  if (/does not explain|missing from the ledger|already completed|reopen it/i.test(message)) return 422;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const reconciliationId = url.searchParams.get("reconciliationId");

  try {
    if (reconciliationId) {
      return NextResponse.json(await getReconciliationWorkspace(reconciliationId));
    }

    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
    const asAt = url.searchParams.get("asAt") ?? new Date().toISOString().slice(0, 10);

    if (url.searchParams.get("view") === "history") {
      const history = await listReconciliationHistory(companyId);
      if (url.searchParams.get("format") === "csv") {
        const csv = toCsv(
          ["Bank account", "Period start", "Period end", "Status", "Per bank statement", "Per general ledger", "Difference", "Completed"],
          history.map((row) => [
            row.bankAccountLabel, row.periodStart, row.periodEnd, row.status,
            row.statementBalance, row.ledgerBalanceAtCompletion, row.difference,
            row.completedAt ? row.completedAt.slice(0, 10) : null,
          ]),
        );
        return new NextResponse(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="reconciliation-history.csv"`,
          },
        });
      }
      return NextResponse.json({ history });
    }

    const [accounts, mappable] = await Promise.all([
      listBankAccounts(companyId, asAt),
      listMappableAccounts(companyId),
    ]);
    return NextResponse.json({ accounts, mappableAccounts: mappable });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load reconciliation.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "map-account": {
        const companyId = String(body.companyId ?? "");
        const ledgerAccountId = String(body.ledgerAccountId ?? "");
        const label = String(body.label ?? "").trim();
        if (!companyId || !ledgerAccountId || !label) {
          return NextResponse.json({ error: "companyId, ledgerAccountId and label are required." }, { status: 400 });
        }
        const bankName = typeof body.bankName === "string" && body.bankName.trim() ? body.bankName.trim() : null;
        const accountNumber =
          typeof body.accountNumber === "string" && body.accountNumber.trim() ? body.accountNumber.trim() : null;
        if (!bankName && !accountNumber) {
          return NextResponse.json(
            { error: "A bank name or an account number is required to match statements to this account." },
            { status: 400 },
          );
        }
        return NextResponse.json({ id: await createBankAccountMapping({ companyId, label, bankName, accountNumber, ledgerAccountId }) }, { status: 201 });
      }

      case "start": {
        const companyId = String(body.companyId ?? "");
        const bankAccountId = String(body.bankAccountId ?? "");
        const periodStart = String(body.periodStart ?? "");
        const periodEnd = String(body.periodEnd ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
          return NextResponse.json({ error: "periodStart and periodEnd must be YYYY-MM-DD." }, { status: 400 });
        }
        return NextResponse.json(await getOrCreateReconciliation({ companyId, bankAccountId, periodStart, periodEnd }));
      }

      case "record-items": {
        await recordReconciliationItems({
          reconciliationId: String(body.reconciliationId ?? ""),
          companyId: String(body.companyId ?? ""),
          entries: Array.isArray(body.entries) ? (body.entries as never[]) : [],
        });
        return NextResponse.json({ ok: true });
      }

      case "remove-item": {
        await removeReconciliationItem(String(body.itemId ?? ""));
        return NextResponse.json({ ok: true });
      }

      case "complete": {
        const statementBalance = Number(body.statementBalance);
        if (!Number.isFinite(statementBalance)) {
          return NextResponse.json({ error: "A statement balance is required to complete a reconciliation." }, { status: 400 });
        }
        await completeReconciliation(String(body.reconciliationId ?? ""), statementBalance);
        return NextResponse.json({ ok: true });
      }

      case "reopen": {
        await reopenReconciliation(String(body.reconciliationId ?? ""));
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the reconciliation.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

import { NextResponse } from "next/server";
import {
  allocateAp,
  createSupplier,
  deallocateAp,
  getControlAccounts,
  listApAgeing,
  listApOpenItems,
  listApUnallocatedPayments,
  listSuppliers,
  setApControlAccount,
} from "@/lib/accounting/receivables-payables-server";

/**
 * Accounts payable. Allocation is delegated to accounting_allocate_ap —
 * this route never decides that a bill and a payment may be matched.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace." || /not found/i.test(message)) return 404;
  if (/exceeds|must name|must be a|different entities|positive/i.test(message)) return 422;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });

  try {
    const asAt = url.searchParams.get("asAt") ?? undefined;
    const [{ apControlAccountId }, suppliers, openItems, unallocated, ageing] = await Promise.all([
      getControlAccounts(companyId),
      listSuppliers(companyId),
      listApOpenItems(companyId, asAt),
      listApUnallocatedPayments(companyId, asAt),
      listApAgeing(companyId, asAt),
    ]);
    return NextResponse.json({ controlAccountId: apControlAccountId, parties: suppliers, openItems, unallocated, ageing });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load accounts payable.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "create-supplier": {
        const companyId = String(body.companyId ?? "");
        const name = String(body.name ?? "").trim();
        if (!companyId || !name) return NextResponse.json({ error: "companyId and name are required." }, { status: 400 });
        const id = await createSupplier({
          companyId,
          name,
          email: typeof body.email === "string" ? body.email.trim() || null : null,
          phone: typeof body.phone === "string" ? body.phone.trim() || null : null,
          address: typeof body.address === "string" ? body.address.trim() || null : null,
        });
        return NextResponse.json({ id }, { status: 201 });
      }

      case "allocate": {
        const companyId = String(body.companyId ?? "");
        const billPostingId = String(body.billPostingId ?? "");
        const paymentPostingId = String(body.paymentPostingId ?? "");
        const amount = Number(body.amount);
        if (!companyId || !billPostingId || !paymentPostingId) {
          return NextResponse.json({ error: "companyId, billPostingId and paymentPostingId are required." }, { status: 400 });
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });
        }
        const id = await allocateAp({ companyId, billPostingId, paymentPostingId, amount });
        return NextResponse.json({ id }, { status: 201 });
      }

      case "deallocate": {
        const allocationId = String(body.allocationId ?? "");
        if (!allocationId) return NextResponse.json({ error: "allocationId is required." }, { status: 400 });
        await deallocateAp(allocationId);
        return NextResponse.json({ ok: true });
      }

      case "set-control-account": {
        const companyId = String(body.companyId ?? "");
        const accountId = String(body.accountId ?? "");
        if (!companyId || !accountId) return NextResponse.json({ error: "companyId and accountId are required." }, { status: 400 });
        await setApControlAccount(companyId, accountId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update accounts payable.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

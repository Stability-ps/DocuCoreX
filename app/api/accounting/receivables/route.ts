import { NextResponse } from "next/server";
import {
  allocateAr,
  createCustomer,
  deallocateAr,
  getControlAccounts,
  listArAgeing,
  listArOpenItems,
  listArUnallocatedReceipts,
  listCustomers,
  setArControlAccount,
} from "@/lib/accounting/receivables-payables-server";

/**
 * Accounts receivable. Allocation is delegated to accounting_allocate_ar —
 * this route never decides that an invoice and a receipt may be matched.
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
    const [{ arControlAccountId }, customers, openItems, unallocated, ageing] = await Promise.all([
      getControlAccounts(companyId),
      listCustomers(companyId),
      listArOpenItems(companyId, asAt),
      listArUnallocatedReceipts(companyId, asAt),
      listArAgeing(companyId, asAt),
    ]);
    return NextResponse.json({ controlAccountId: arControlAccountId, parties: customers, openItems, unallocated, ageing });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load accounts receivable.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "create-customer": {
        const companyId = String(body.companyId ?? "");
        const name = String(body.name ?? "").trim();
        if (!companyId || !name) return NextResponse.json({ error: "companyId and name are required." }, { status: 400 });
        const id = await createCustomer({
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
        const invoicePostingId = String(body.invoicePostingId ?? "");
        const receiptPostingId = String(body.receiptPostingId ?? "");
        const amount = Number(body.amount);
        if (!companyId || !invoicePostingId || !receiptPostingId) {
          return NextResponse.json({ error: "companyId, invoicePostingId and receiptPostingId are required." }, { status: 400 });
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });
        }
        const id = await allocateAr({ companyId, invoicePostingId, receiptPostingId, amount });
        return NextResponse.json({ id }, { status: 201 });
      }

      case "deallocate": {
        const allocationId = String(body.allocationId ?? "");
        if (!allocationId) return NextResponse.json({ error: "allocationId is required." }, { status: 400 });
        await deallocateAr(allocationId);
        return NextResponse.json({ ok: true });
      }

      case "set-control-account": {
        const companyId = String(body.companyId ?? "");
        const accountId = String(body.accountId ?? "");
        if (!companyId || !accountId) return NextResponse.json({ error: "companyId and accountId are required." }, { status: 400 });
        await setArControlAccount(companyId, accountId);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update accounts receivable.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

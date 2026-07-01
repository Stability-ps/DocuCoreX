import { NextResponse } from "next/server";
import { updateAccountingTransaction } from "@/lib/accounting/server";
import type { AccountingTransactionPatch } from "@/lib/accounting/types";

const allowedVatTreatments = new Set(["standard", "zero_rated", "exempt", "out_of_scope", "review"]);
const allowedReviewStatuses = new Set(["needs_review", "ready", "approved"]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as AccountingTransactionPatch;

  if (body.vatTreatment && !allowedVatTreatments.has(body.vatTreatment)) {
    return NextResponse.json({ error: "Invalid VAT treatment." }, { status: 400 });
  }

  if (body.reviewStatus && !allowedReviewStatuses.has(body.reviewStatus)) {
    return NextResponse.json({ error: "Invalid review status." }, { status: 400 });
  }

  try {
    const transaction = await updateAccountingTransaction(id, body);
    return NextResponse.json({ transaction });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update transaction.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

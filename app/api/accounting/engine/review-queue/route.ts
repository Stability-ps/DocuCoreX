import { NextResponse } from "next/server";
import { listAccountingReviewQueue, updateAccountingReviewWorkflow } from "@/lib/accounting/server";
import type { ReviewQueueStatus } from "@/lib/accounting/engine/types";

const allowedStatuses = new Set<ReviewQueueStatus>(["needs_review", "in_review", "approved", "rejected", "resolved"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  try {
    const items = await listAccountingReviewQueue(status && allowedStatuses.has(status as ReviewQueueStatus) ? (status as ReviewQueueStatus) : undefined);
    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load review queue.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    transactionId?: string;
    status?: ReviewQueueStatus;
    comment?: string;
  };

  if (!body.transactionId) {
    return NextResponse.json({ error: "transactionId is required." }, { status: 400 });
  }
  if (!body.status || !allowedStatuses.has(body.status)) {
    return NextResponse.json({ error: "A valid review status is required." }, { status: 400 });
  }

  try {
    const transaction = await updateAccountingReviewWorkflow(body.transactionId, body.status, body.comment ?? "");
    return NextResponse.json({ transaction });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update review workflow.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { addAccountingReviewComment, listAccountingReviewComments } from "@/lib/accounting/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const transactionId = url.searchParams.get("transactionId");

  if (!transactionId) {
    return NextResponse.json({ error: "transactionId is required." }, { status: 400 });
  }

  try {
    const comments = await listAccountingReviewComments(transactionId);
    return NextResponse.json({ comments });
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.engine_review_queue_comments.get_failed", error, { message: "Unable to load review comments." });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    transactionId?: string;
    body?: string;
  };

  if (!body.transactionId || !body.body?.trim()) {
    return NextResponse.json({ error: "transactionId and comment body are required." }, { status: 400 });
  }

  try {
    const comment = await addAccountingReviewComment(body.transactionId, body.body.trim());
    return NextResponse.json({ comment });
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.engine_review_queue_comments.post_failed", error, { message: "Unable to add review comment." });
  }
}

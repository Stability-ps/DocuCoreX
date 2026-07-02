import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Unable to load review comments.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
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
    const message = error instanceof Error ? error.message : "Unable to add review comment.";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

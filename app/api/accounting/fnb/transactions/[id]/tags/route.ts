import { NextResponse } from "next/server";
import { addTransactionTag, removeTransactionTag } from "@/lib/accounting/server";

/**
 * Tags on a single transaction.
 *
 * Separate from the transaction PATCH route on purpose: that endpoint changes
 * accounting treatment (category, VAT, review status), and a tag is a business
 * grouping that changes none of those. Keeping them apart means a tag edit can
 * never be mistaken for — or accidentally batched with — a change to how a
 * transaction is booked.
 */

function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Transaction not found.") return 404;
  return 400;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { tag?: unknown };

  if (typeof body.tag !== "string") {
    return NextResponse.json({ error: "A tag is required." }, { status: 400 });
  }

  try {
    const tags = await addTransactionTag(id, body.tag);
    return NextResponse.json({ tags });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to add tag.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The tag travels in the query string: a DELETE body is permitted but not
  // reliably forwarded by every intermediary, and this is the identifier.
  const tag = new URL(request.url).searchParams.get("tag");

  if (!tag) {
    return NextResponse.json({ error: "A tag is required." }, { status: 400 });
  }

  try {
    const tags = await removeTransactionTag(id, tag);
    return NextResponse.json({ tags });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove tag.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

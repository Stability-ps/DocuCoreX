import { NextResponse } from "next/server";
import { clearTransferMatch, decideTransferMatch, getWorkspaceTransferCandidates } from "@/lib/accounting/server";

/**
 * Inter-account transfer candidates and the decisions made about them.
 *
 * Workspace-scoped rather than statement-scoped, because a transfer's two legs
 * are recorded on two different statements. Under /api/accounting/transfers
 * rather than /api/accounting/fnb/... — this is not bank-specific.
 */

function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Transaction not found.") return 404;
  return 400;
}

export async function GET() {
  try {
    const result = await getWorkspaceTransferCandidates();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load transfer candidates.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    outboundTransactionId?: unknown;
    inboundTransactionId?: unknown;
    status?: unknown;
    evidence?: unknown;
  };

  if (typeof body.outboundTransactionId !== "string" || typeof body.inboundTransactionId !== "string") {
    return NextResponse.json({ error: "Both transaction ids are required." }, { status: 400 });
  }
  // Only these two. A transfer is confirmed or it is not — there is no
  // "probably", because a stored maybe would eventually be read as a yes.
  if (body.status !== "confirmed" && body.status !== "rejected") {
    return NextResponse.json({ error: "Status must be confirmed or rejected." }, { status: 400 });
  }

  try {
    await decideTransferMatch({
      outboundTransactionId: body.outboundTransactionId,
      inboundTransactionId: body.inboundTransactionId,
      status: body.status,
      evidence: Array.isArray(body.evidence) ? body.evidence.filter((line): line is string => typeof line === "string") : [],
    });
    return NextResponse.json(await getWorkspaceTransferCandidates());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record the transfer decision.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const outbound = url.searchParams.get("outboundTransactionId");
  const inbound = url.searchParams.get("inboundTransactionId");

  if (!outbound || !inbound) {
    return NextResponse.json({ error: "Both transaction ids are required." }, { status: 400 });
  }

  try {
    await clearTransferMatch(outbound, inbound);
    return NextResponse.json(await getWorkspaceTransferCandidates());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to clear the transfer decision.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

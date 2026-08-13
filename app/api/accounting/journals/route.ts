import { NextResponse } from "next/server";
import { createJournal, listJournals } from "@/lib/accounting/journals-server";
import type { JournalLineInput, JournalType } from "@/lib/accounting/journals";

/**
 * Journals for one entity.
 *
 * Posting is delegated to the accounting_post_journal RPC by the server module.
 * This route never inserts a posting itself — the RPC is the only door into the
 * ledger, so a balance check cannot be skipped by adding another caller.
 */

const JOURNAL_TYPES = new Set<JournalType>([
  "general", "adjustment", "opening_balance", "depreciation",
  "accrual", "prepayment", "tax", "closing", "reversal",
]);

function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  // A refused post is the caller's request being wrong, not the server failing.
  if (/does not balance|cannot be posted|already posted|is locked|is soft_closed|reopen it/i.test(message)) return 422;
  return 500;
}

export async function GET(request: Request) {
  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required." }, { status: 400 });
  }

  try {
    return NextResponse.json({ journals: await listJournals(companyId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load journals.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const companyId = typeof body.companyId === "string" ? body.companyId : "";
  const journalDate = typeof body.journalDate === "string" ? body.journalDate : "";
  const journalType = (typeof body.journalType === "string" ? body.journalType : "general") as JournalType;
  const lines = Array.isArray(body.lines) ? (body.lines as JournalLineInput[]) : [];

  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(journalDate)) {
    return NextResponse.json({ error: "journalDate must be YYYY-MM-DD." }, { status: 400 });
  }
  if (!JOURNAL_TYPES.has(journalType)) {
    return NextResponse.json({ error: "Unknown journal type." }, { status: 400 });
  }

  try {
    const result = await createJournal({
      companyId,
      journalType,
      reference: typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null,
      journalDate,
      description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
      lines: lines.map((line) => ({
        accountId: String(line.accountId ?? ""),
        debit: Number(line.debit ?? 0),
        credit: Number(line.credit ?? 0),
        description: typeof line.description === "string" ? line.description : null,
        taxCodeId: typeof line.taxCodeId === "string" && line.taxCodeId ? line.taxCodeId : null,
      })),
      post: body.post === true,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create the journal.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

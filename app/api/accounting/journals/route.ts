import { NextResponse } from "next/server";
import { createJournal, listJournals } from "@/lib/accounting/journals-server";
import { toCsv } from "@/lib/accounting/ledger";
import type { JournalLineInput, JournalType } from "@/lib/accounting/journals";

/**
 * Journals for one entity.
 *
 * Posting is delegated to the accounting_post_journal RPC by the server module.
 * This route never inserts a posting itself — the RPC is the only door into the
 * ledger, so a balance check cannot be skipped by adding another caller.
 */

// Kept as an explicit list, not JournalType's own keys, so a route accepting
// external input has its own record of what it allows — but that means a new
// type added to journals.ts (as 'disposal' was, in the fixed-assets stage)
// must be added here too, or this route silently refuses it. It had been.
const JOURNAL_TYPES = new Set<JournalType>([
  "general", "adjustment", "opening_balance", "depreciation", "disposal",
  "accrual", "prepayment", "tax", "closing", "reversal",
]);

function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  // A refused post is the caller's request being wrong, not the server failing.
  if (/does not balance|cannot be posted|already posted|is locked|is soft_closed|reopen it|must name/i.test(message)) return 422;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required." }, { status: 400 });
  }

  try {
    const journals = await listJournals(companyId);

    if (url.searchParams.get("format") === "csv") {
      const csv = toCsv(
        ["reference", "date", "type", "status", "description", "debit", "credit", "lines"],
        journals.map((j) => [j.reference, j.journalDate, j.journalType, j.status, j.description, j.totalDebit, j.totalCredit, j.lineCount]),
      );
      return new NextResponse(csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="journals.csv"` },
      });
    }

    return NextResponse.json({ journals });
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
        customerId: typeof line.customerId === "string" && line.customerId ? line.customerId : null,
        supplierId: typeof line.supplierId === "string" && line.supplierId ? line.supplierId : null,
      })),
      post: body.post === true,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create the journal.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

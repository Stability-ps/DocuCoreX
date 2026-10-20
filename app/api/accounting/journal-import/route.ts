import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { parseCsvWithHeader } from "@/lib/accounting/csv";
import { readJournalImportRow, summariseJournalOutcomes } from "@/lib/accounting/journal-import";
import { commitJournalImport, previewJournalImport } from "@/lib/accounting/journal-import-server";

/**
 * Bulk journal import.
 *
 * Preview and commit both parse the SAME uploaded text and run the SAME
 * group-level validator — commit never trusts a client-supplied "these
 * groups were valid" list from an earlier preview call. Every journal it
 * posts goes through createJournal / accounting_post_journal, the same gate
 * as a hand-typed journal.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const companyId = String(body.companyId ?? "");
  const csvText = typeof body.csvText === "string" ? body.csvText : "";

  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
  if (!csvText.trim()) return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });

  const { rows } = parseCsvWithHeader(csvText);
  if (!rows.length) return NextResponse.json({ error: "No data rows found — check the file has a header row and at least one line." }, { status: 400 });
  const importRows = rows.map((r) => readJournalImportRow(r.rowNumber, r.cells));

  try {
    switch (action) {
      case "preview": {
        const outcomes = await previewJournalImport(companyId, importRows);
        return NextResponse.json({ outcomes, summary: summariseJournalOutcomes(outcomes) });
      }

      case "commit": {
        const filename = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "upload.csv";
        const result = await commitJournalImport({ companyId, filename, rows: importRows });
        return NextResponse.json(result, { status: 201 });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.journal_import.post_failed", error, { message: "Unable to process the import." });
  }
}

import { NextResponse } from "next/server";
import { parseCsvWithHeader } from "@/lib/accounting/csv";
import { readCoaImportRow, summariseCoaOutcomes } from "@/lib/accounting/coa-import";
import { commitCoaImport, previewCoaImport } from "@/lib/accounting/coa-import-server";

/**
 * Chart of accounts import.
 *
 * Preview and commit both parse the SAME uploaded text and run the SAME
 * validator (coa-import.ts) — commit never trusts a client-supplied "these
 * rows were valid" list from an earlier preview call.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace.") return 404;
  return 500;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const companyId = String(body.companyId ?? "");
  const csvText = typeof body.csvText === "string" ? body.csvText : "";

  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
  if (!csvText.trim()) return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });

  const { rows } = parseCsvWithHeader(csvText);
  if (!rows.length) return NextResponse.json({ error: "No data rows found — check the file has a header row and at least one account." }, { status: 400 });
  const importRows = rows.map((r) => readCoaImportRow(r.rowNumber, r.cells));

  try {
    switch (action) {
      case "preview": {
        const outcomes = await previewCoaImport(companyId, importRows);
        return NextResponse.json({ outcomes, summary: summariseCoaOutcomes(outcomes) });
      }

      case "commit": {
        const filename = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "upload.csv";
        const result = await commitCoaImport({ companyId, filename, rows: importRows });
        return NextResponse.json(result, { status: 201 });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process the import.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

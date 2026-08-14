import { NextResponse } from "next/server";
import { toCsv } from "@/lib/accounting/ledger";
import { getImportBatch, listImportBatches, listImportBatchErrors } from "@/lib/accounting/import-history-server";

/**
 * Import history. Entirely read-only — every table this route reads from is
 * append-only (migration 044), so there is no POST/PATCH/DELETE here to have
 * omitted; there is nothing this route could ever legitimately change.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace." || message === "Import batch not found.") return 404;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");

  try {
    if (batchId) {
      const [batch, errors] = await Promise.all([getImportBatch(batchId), listImportBatchErrors(batchId)]);

      if (url.searchParams.get("format") === "csv") {
        const csv = toCsv(
          ["reference_or_code", "rows", "message"],
          errors.map((e) => [e.groupReference ?? "", e.rowNumbers.join("; "), e.message]),
        );
        return new NextResponse(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${batch.filename.replace(/\.csv$/i, "")}-errors.csv"`,
          },
        });
      }

      return NextResponse.json({ batch, errors });
    }

    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });
    return NextResponse.json({ batches: await listImportBatches(companyId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load import history.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

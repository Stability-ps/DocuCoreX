import { NextResponse } from "next/server";
import { assertWorkspaceAdmin } from "@/lib/accounting/engine/admin";

export async function GET() {
  try {
    const context = await assertWorkspaceAdmin();

    const [{ data: aggregateData, error: aggregateError }, { data: failureData, error: failureError }] = await Promise.all([
      context.supabase
        .from("accounting_statement_analytics")
        .select("bank, statements_processed, success_rate, average_confidence, average_processing_ms, average_review_rate")
        .eq("workspace_id", context.workspaceId)
        .order("updated_at", { ascending: false }),
      context.supabase
        .from("accounting_parser_failures")
        .select("bank, failure_reason, failure_count")
        .eq("workspace_id", context.workspaceId)
        .order("failure_count", { ascending: false })
        .limit(200),
    ]);

    if (aggregateError && aggregateError.code !== "42P01" && aggregateError.code !== "PGRST204") {
      throw new Error(aggregateError.message);
    }
    if (failureError && failureError.code !== "42P01" && failureError.code !== "PGRST204") {
      throw new Error(failureError.message);
    }

    const failuresByBank = new Map<string, string[]>();
    for (const row of failureData ?? []) {
      const current = failuresByBank.get(row.bank) ?? [];
      if (current.length < 5) {
        current.push(`${row.failure_reason} (${row.failure_count})`);
      }
      failuresByBank.set(row.bank, current);
    }

    const analytics = (aggregateData ?? []).map((row) => ({
      bank: row.bank,
      statementsProcessed: Number(row.statements_processed ?? 0),
      successRate: Number(row.success_rate ?? 0),
      averageConfidence: Number(row.average_confidence ?? 0),
      averageProcessingMs: Number(row.average_processing_ms ?? 0),
      averageReviewRate: Number(row.average_review_rate ?? 0),
      commonFailures: failuresByBank.get(row.bank) ?? [],
    }));

    return NextResponse.json({ analytics });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load statement analytics.";
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

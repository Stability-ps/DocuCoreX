import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import {
  closeAccountingPeriod,
  getPeriodReadiness,
  listAccountingPeriods,
  reopenAccountingPeriod,
} from "@/lib/accounting/period-close-server";

/**
 * Period close.
 *
 * Both close and reopen are delegated to accounting_close_period /
 * accounting_reopen_period (migration 041), which own the rules — a locked
 * period refuses to be created over unposted journals, and a reopen refuses
 * without a reason. This route never decides either of those for itself.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });

  try {
    if (url.searchParams.get("view") === "readiness") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return NextResponse.json({ error: "from and to must be YYYY-MM-DD." }, { status: 400 });
      }
      return NextResponse.json(await getPeriodReadiness(companyId, from, to));
    }

    return NextResponse.json({ periods: await listAccountingPeriods(companyId) });
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.periods.get_failed", error, { message: "Unable to load periods." });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "close": {
        const companyId = String(body.companyId ?? "");
        const from = String(body.from ?? "");
        const to = String(body.to ?? "");
        const status = String(body.status ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return NextResponse.json({ error: "from and to must be YYYY-MM-DD." }, { status: 400 });
        }
        if (status !== "soft_closed" && status !== "locked") {
          return NextResponse.json({ error: "status must be soft_closed or locked." }, { status: 400 });
        }
        const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
        const id = await closeAccountingPeriod({ companyId, from, to, status, note });
        return NextResponse.json({ id }, { status: 201 });
      }

      case "reopen": {
        const periodId = String(body.periodId ?? "");
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!periodId) return NextResponse.json({ error: "periodId is required." }, { status: 400 });
        if (!reason) return NextResponse.json({ error: "A reason is required to reopen a closed period." }, { status: 400 });
        await reopenAccountingPeriod(periodId, reason);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    return routeErrorResponse("docucorex.accounting.periods.post_failed", error, { message: "Unable to update the period." });
  }
}

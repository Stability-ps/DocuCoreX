import { NextResponse } from "next/server";
import {
  createFixedAsset,
  disposeFixedAsset,
  listFixedAssets,
  previewDepreciationBatch,
  runDepreciationBatch,
} from "@/lib/accounting/fixed-assets-server";

/**
 * Fixed assets. Depreciation and disposal are both posted through
 * createJournal (journals-server.ts) — this route never decides that a
 * journal balances or that a period is open to post into; the existing gate
 * decides both.
 */
function statusFor(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message === "Entity not found in this workspace." || message === "Fixed asset not found.") return 404;
  if (/already been disposed|proceeds were received|does not balance|is locked|unposted/i.test(message)) return 422;
  return 500;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required." }, { status: 400 });

  try {
    if (url.searchParams.get("view") === "depreciation-preview") {
      const monthEnd = url.searchParams.get("monthEnd") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(monthEnd)) {
        return NextResponse.json({ error: "monthEnd must be YYYY-MM-DD." }, { status: 400 });
      }
      return NextResponse.json({ entries: await previewDepreciationBatch(companyId, monthEnd) });
    }

    const asAt = url.searchParams.get("asAt") ?? undefined;
    return NextResponse.json({ assets: await listFixedAssets(companyId, asAt) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load fixed assets.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "create-asset": {
        const companyId = String(body.companyId ?? "");
        const description = String(body.description ?? "").trim();
        const assetAccountId = String(body.assetAccountId ?? "");
        const accumulatedDepreciationAccountId = String(body.accumulatedDepreciationAccountId ?? "");
        const acquisitionDate = String(body.acquisitionDate ?? "");
        const cost = Number(body.cost);
        const residualValue = Number(body.residualValue ?? 0);
        const depreciationMethod = String(body.depreciationMethod ?? "none") as "straight_line" | "reducing_balance" | "none";

        if (!companyId || !description || !assetAccountId || !accumulatedDepreciationAccountId) {
          return NextResponse.json({ error: "companyId, description, assetAccountId and accumulatedDepreciationAccountId are required." }, { status: 400 });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(acquisitionDate)) {
          return NextResponse.json({ error: "acquisitionDate must be YYYY-MM-DD." }, { status: 400 });
        }
        if (!Number.isFinite(cost) || cost < 0) {
          return NextResponse.json({ error: "cost must be a non-negative number." }, { status: 400 });
        }

        const id = await createFixedAsset({
          companyId,
          description,
          assetAccountId,
          accumulatedDepreciationAccountId,
          acquisitionDate,
          cost,
          residualValue,
          depreciationMethod,
          usefulLifeMonths: depreciationMethod === "straight_line" ? Number(body.usefulLifeMonths) : null,
          depreciationRatePercent: depreciationMethod === "reducing_balance" ? Number(body.depreciationRatePercent) : null,
        });
        return NextResponse.json({ id }, { status: 201 });
      }

      case "run-depreciation": {
        const companyId = String(body.companyId ?? "");
        const monthEnd = String(body.monthEnd ?? "");
        const expenseAccountId = String(body.expenseAccountId ?? "");
        const entries = Array.isArray(body.entries) ? (body.entries as never[]) : [];
        if (!companyId || !expenseAccountId || !entries.length) {
          return NextResponse.json({ error: "companyId, expenseAccountId and at least one entry are required." }, { status: 400 });
        }
        const result = await runDepreciationBatch({ companyId, monthEnd, expenseAccountId, entries });
        return NextResponse.json(result);
      }

      case "dispose": {
        const companyId = String(body.companyId ?? "");
        const assetId = String(body.assetId ?? "");
        const disposalDate = String(body.disposalDate ?? "");
        const proceeds = Number(body.proceeds ?? 0);
        const proceedsAccountId = typeof body.proceedsAccountId === "string" && body.proceedsAccountId ? body.proceedsAccountId : null;
        const gainLossAccountId = String(body.gainLossAccountId ?? "");

        if (!companyId || !assetId || !gainLossAccountId) {
          return NextResponse.json({ error: "companyId, assetId and gainLossAccountId are required." }, { status: 400 });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(disposalDate)) {
          return NextResponse.json({ error: "disposalDate must be YYYY-MM-DD." }, { status: 400 });
        }
        if (!Number.isFinite(proceeds) || proceeds < 0) {
          return NextResponse.json({ error: "proceeds must be a non-negative number." }, { status: 400 });
        }

        await disposeFixedAsset({ companyId, assetId, disposalDate, proceeds, proceedsAccountId, gainLossAccountId });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update fixed assets.";
    return NextResponse.json({ error: message }, { status: statusFor(message) });
  }
}

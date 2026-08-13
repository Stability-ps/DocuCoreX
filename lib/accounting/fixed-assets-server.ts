/**
 * Fixed assets data access.
 *
 * Every posting goes through createJournal (journals-server.ts) — the same
 * gate every other journal in this product posts through. Nothing here
 * inserts into accounting_postings directly, and nothing here duplicates the
 * balance or period-lock checks that gate already makes.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import { createJournal } from "@/lib/accounting/journals-server";
import { disposalEntry, monthlyDepreciationCharge, type DepreciationMethod, type FixedAsset } from "@/lib/accounting/fixed-assets";

async function requireEntity(companyId: string) {
  const context = await getWorkspaceContext();
  if (!context) throw new Error("Supabase is not configured");
  const { data, error } = await context.supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Entity not found in this workspace.");
  return context;
}

function mapAsset(row: Record<string, unknown>): FixedAsset {
  return {
    id: String(row.asset_id),
    description: String(row.description),
    assetAccountId: String(row.asset_account_id),
    assetAccountCode: String(row.asset_account_code),
    assetAccountName: String(row.asset_account_name),
    accumulatedDepreciationAccountId: String(row.accumulated_depreciation_account_id),
    acquisitionDate: String(row.acquisition_date),
    cost: Number(row.cost),
    residualValue: Number(row.residual_value),
    depreciationMethod: row.depreciation_method as DepreciationMethod,
    usefulLifeMonths: row.useful_life_months === null ? null : Number(row.useful_life_months),
    depreciationRatePercent: row.depreciation_rate_percent === null ? null : Number(row.depreciation_rate_percent),
    accumulatedDepreciation: Number(row.accumulated_depreciation),
    netBookValue: Number(row.net_book_value),
    isActive: Boolean(row.is_active),
    disposalDate: (row.disposal_date as string | null) ?? null,
    disposalProceeds: row.disposal_proceeds === null ? null : Number(row.disposal_proceeds),
  };
}

export async function listFixedAssets(companyId: string, asAt?: string): Promise<FixedAsset[]> {
  const context = await requireEntity(companyId);
  const { data, error } = await context.supabase.rpc("accounting_fixed_asset_register", {
    target_company: companyId,
    as_at: asAt ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapAsset);
}

export async function createFixedAsset(input: {
  companyId: string;
  description: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  acquisitionDate: string;
  cost: number;
  residualValue: number;
  depreciationMethod: DepreciationMethod;
  usefulLifeMonths: number | null;
  depreciationRatePercent: number | null;
}): Promise<string> {
  const context = await requireEntity(input.companyId);

  const { data, error } = await context.supabase
    .from("accounting_fixed_assets")
    .insert({
      company_id: input.companyId,
      workspace_id: context.workspaceId,
      description: input.description,
      asset_account_id: input.assetAccountId,
      accumulated_depreciation_account_id: input.accumulatedDepreciationAccountId,
      acquisition_date: input.acquisitionDate,
      cost: input.cost,
      residual_value: input.residualValue,
      depreciation_method: input.depreciationMethod,
      useful_life_months: input.usefulLifeMonths,
      depreciation_rate_percent: input.depreciationRatePercent,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return String(data.id);
}

/** Last day of the calendar month monthEnd falls in — the day before its next month starts. */
function endOfMonth(monthEnd: string): string {
  const [year, month] = monthEnd.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

function startOfMonth(monthEnd: string): string {
  return `${monthEnd.slice(0, 7)}-01`;
}

export type DepreciationBatchEntry = {
  assetId: string;
  description: string;
  accumulatedDepreciationAccountId: string;
  amount: number;
};

/**
 * What a depreciation run for this month would post, per eligible asset.
 * Assets already charged this month (accounting_asset_movements' unique
 * index would refuse a second one) are left out rather than shown and then
 * rejected.
 */
export async function previewDepreciationBatch(companyId: string, monthEnd: string): Promise<DepreciationBatchEntry[]> {
  const context = await requireEntity(companyId);
  const priorAsAt = new Date(startOfMonth(monthEnd));
  priorAsAt.setUTCDate(priorAsAt.getUTCDate() - 1);
  const priorAsAtIso = priorAsAt.toISOString().slice(0, 10);

  const [assets, alreadyRun] = await Promise.all([
    listFixedAssets(companyId, priorAsAtIso),
    context.supabase
      .from("accounting_asset_movements")
      .select("fixed_asset_id")
      .eq("company_id", companyId)
      .eq("movement_type", "depreciation")
      .gte("movement_date", startOfMonth(monthEnd))
      .lte("movement_date", endOfMonth(monthEnd)),
  ]);

  const alreadyRunIds = new Set((alreadyRun.data ?? []).map((row) => String(row.fixed_asset_id)));
  const monthEndDate = endOfMonth(monthEnd);

  return assets
    .filter((asset) => asset.isActive && !alreadyRunIds.has(asset.id))
    .map((asset) => ({
      asset,
      amount: monthlyDepreciationCharge(asset, asset.accumulatedDepreciation, monthEndDate),
    }))
    .filter((entry) => entry.amount > 0)
    .map((entry) => ({
      assetId: entry.asset.id,
      description: entry.asset.description,
      accumulatedDepreciationAccountId: entry.asset.accumulatedDepreciationAccountId,
      amount: entry.amount,
    }));
}

/**
 * Post the batch: one journal per asset, never combined (see migration 042 —
 * combining two assets' depreciation onto one journal would make the register
 * unable to tell which asset a shared credit line belonged to).
 */
export async function runDepreciationBatch(input: {
  companyId: string;
  monthEnd: string;
  expenseAccountId: string;
  entries: DepreciationBatchEntry[];
}): Promise<{ posted: string[]; failed: Array<{ assetId: string; message: string }> }> {
  const context = await requireEntity(input.companyId);
  const monthEndDate = endOfMonth(input.monthEnd);
  const posted: string[] = [];
  const failed: Array<{ assetId: string; message: string }> = [];

  for (const entry of input.entries) {
    try {
      const { journalId } = await createJournal({
        companyId: input.companyId,
        journalType: "depreciation",
        reference: null,
        journalDate: monthEndDate,
        description: `Depreciation — ${entry.description}`,
        lines: [
          { accountId: input.expenseAccountId, debit: entry.amount, credit: 0 },
          { accountId: entry.accumulatedDepreciationAccountId, debit: 0, credit: entry.amount },
        ],
        post: true,
      });

      const { error: movementError } = await context.supabase.from("accounting_asset_movements").insert({
        fixed_asset_id: entry.assetId,
        company_id: input.companyId,
        workspace_id: context.workspaceId,
        journal_id: journalId,
        movement_type: "depreciation",
        movement_date: monthEndDate,
      });
      if (movementError) throw new Error(movementError.message);

      posted.push(entry.assetId);
    } catch (error) {
      failed.push({ assetId: entry.assetId, message: error instanceof Error ? error.message : "Unable to post depreciation." });
    }
  }

  return { posted, failed };
}

export async function disposeFixedAsset(input: {
  companyId: string;
  assetId: string;
  disposalDate: string;
  proceeds: number;
  proceedsAccountId: string | null;
  gainLossAccountId: string;
}): Promise<void> {
  const context = await requireEntity(input.companyId);

  const assets = await listFixedAssets(input.companyId, input.disposalDate);
  const asset = assets.find((candidate) => candidate.id === input.assetId);
  if (!asset) throw new Error("Fixed asset not found.");
  if (asset.disposalDate) throw new Error("This asset has already been disposed.");
  if (input.proceeds > 0 && !input.proceedsAccountId) {
    throw new Error("An account is required for where the proceeds were received.");
  }

  const entry = disposalEntry({ cost: asset.cost, accumulatedDepreciation: asset.accumulatedDepreciation, proceeds: input.proceeds });

  const lines = [
    { accountId: asset.accumulatedDepreciationAccountId, debit: entry.accumulatedDepreciationDebit, credit: 0 },
    { accountId: asset.assetAccountId, debit: 0, credit: entry.costCredit },
  ];
  if (entry.proceedsDebit > 0 && input.proceedsAccountId) {
    lines.push({ accountId: input.proceedsAccountId, debit: entry.proceedsDebit, credit: 0 });
  }
  if (entry.gain > 0) {
    lines.push({ accountId: input.gainLossAccountId, debit: 0, credit: entry.gain });
  } else if (entry.loss > 0) {
    lines.push({ accountId: input.gainLossAccountId, debit: entry.loss, credit: 0 });
  }

  const { journalId } = await createJournal({
    companyId: input.companyId,
    journalType: "disposal",
    reference: null,
    journalDate: input.disposalDate,
    description: `Disposal — ${asset.description}`,
    lines,
    post: true,
  });

  const { error: movementError } = await context.supabase.from("accounting_asset_movements").insert({
    fixed_asset_id: input.assetId,
    company_id: input.companyId,
    workspace_id: context.workspaceId,
    journal_id: journalId,
    movement_type: "disposal",
    movement_date: input.disposalDate,
  });
  if (movementError) throw new Error(movementError.message);

  const { error: updateError } = await context.supabase
    .from("accounting_fixed_assets")
    .update({ disposal_date: input.disposalDate, disposal_proceeds: input.proceeds, is_active: false, updated_at: new Date().toISOString() })
    .eq("id", input.assetId);
  if (updateError) throw new Error(updateError.message);
}

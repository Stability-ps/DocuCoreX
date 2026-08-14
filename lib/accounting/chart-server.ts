/**
 * Chart-of-accounts data access.
 *
 * Separated from chart.ts because that module is imported by a CLIENT
 * component. Keeping getWorkspaceContext here stops `next/headers` being pulled
 * into the browser bundle — the whole module graph follows the import, so one
 * shared file holding both would break the build for every consumer of either.
 */

import { getWorkspaceContext } from "@/lib/server-documents";
import type { AccountingEntity, AccountType, LedgerAccount, NormalBalance } from "@/lib/accounting/chart";

type AccountRow = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  parent_id: string | null;
  is_active: boolean;
  is_system: boolean;
  vat_default: string | null;
  description: string | null;
};

function mapAccount(row: AccountRow): LedgerAccount {
  return {
    id: row.id,
    companyId: row.company_id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    normalBalance: row.normal_balance,
    parentId: row.parent_id,
    isActive: row.is_active,
    isSystem: row.is_system,
    vatDefault: row.vat_default,
    description: row.description,
  };
}

/**
 * The entities in the workspace, with their accounting configuration.
 *
 * An entity is a `companies` row — the same record invoices are issued from —
 * so an accountant never has to reconcile two ideas of the same company.
 */
export async function listAccountingEntities(): Promise<AccountingEntity[]> {
  const context = await getWorkspaceContext();
  if (!context) return [];

  const { data, error } = await context.supabase
    .from("companies")
    .select(
      "id, business_name, registration_number, vat_number, is_default, accounting_entity_settings(base_currency, reporting_framework, financial_year_end_month, financial_year_end_day, ar_control_account_id, ap_control_account_id)",
    )
    .eq("workspace_id", context.workspaceId)
    .eq("is_archived", false)
    .order("is_default", { ascending: false })
    .order("business_name", { ascending: true });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    // Supabase returns an embedded one-to-one either as an object or as a
    // single-element array depending on how it infers the relationship, so both
    // are handled rather than assuming one.
    const raw = (row as Record<string, unknown>).accounting_entity_settings;
    const settings = (Array.isArray(raw) ? raw[0] : raw) as
      | {
          base_currency?: string;
          reporting_framework?: string | null;
          financial_year_end_month?: number;
          financial_year_end_day?: number;
          ar_control_account_id?: string | null;
          ap_control_account_id?: string | null;
        }
      | undefined;

    return {
      id: String(row.id),
      name: String(row.business_name ?? "Untitled entity"),
      registrationNumber: (row.registration_number as string | null) ?? null,
      vatNumber: (row.vat_number as string | null) ?? null,
      isDefault: Boolean(row.is_default),
      baseCurrency: settings?.base_currency ?? "ZAR",
      reportingFramework: settings?.reporting_framework ?? null,
      financialYearEndMonth: settings?.financial_year_end_month ?? 2,
      financialYearEndDay: settings?.financial_year_end_day ?? 28,
      arControlAccountId: settings?.ar_control_account_id ?? null,
      apControlAccountId: settings?.ap_control_account_id ?? null,
    };
  });
}

/**
 * One entity's chart of accounts.
 *
 * `companyId` is verified against the workspace before anything is read. RLS
 * already prevents cross-workspace access, but an explicit check turns a silent
 * empty result into a clear error, which is the difference between "this entity
 * has no accounts" and "this entity is not yours".
 */
export async function listChartOfAccounts(companyId: string): Promise<LedgerAccount[]> {
  const context = await getWorkspaceContext();
  if (!context) return [];

  const { data: company, error: companyError } = await context.supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();

  if (companyError) throw new Error(companyError.message);
  if (!company) throw new Error("Entity not found in this workspace.");

  const { data, error } = await context.supabase
    .from("accounting_accounts")
    .select("id, company_id, code, name, account_type, normal_balance, parent_id, is_active, is_system, vat_default, description")
    .eq("company_id", companyId)
    .order("code", { ascending: true });

  if (error) throw new Error(error.message);
  return ((data ?? []) as AccountRow[]).map(mapAccount);
}

/**
 * Chart of accounts import: parsing rows into an upsert plan, and validating
 * that plan against the entity's existing chart.
 *
 * No server imports — the browser and the tests both use this. Validation
 * takes the existing chart as a plain argument rather than fetching it, so
 * the same function runs identically at preview and at commit: preview calls
 * it and stops; commit calls it again against a fresh read and only then
 * proceeds, rather than trusting whatever the client said preview showed.
 */

import type { AccountType, LedgerAccount, NormalBalance } from "@/lib/accounting/chart";

const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "cost_of_sales", "expense", "other_income", "other_expense", "taxation"];
const NORMAL_BALANCES: NormalBalance[] = ["debit", "credit"];
const VAT_DEFAULTS = ["standard", "zero_rated", "exempt", "out_of_scope", "review"];

export type CoaImportRow = {
  rowNumber: number;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentCode: string | null;
  vatDefault: string | null;
  description: string | null;
};

/** Reads the header-keyed cells produced by parseCsvWithHeader into a row. Blank optional cells become null, not empty strings. */
export function readCoaImportRow(rowNumber: number, cells: Record<string, string>): CoaImportRow {
  const blank = (value: string | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    rowNumber,
    code: (cells.code ?? cells.account_code ?? "").trim(),
    name: (cells.name ?? cells.account_name ?? "").trim(),
    accountType: (cells.account_type ?? cells.type ?? "").trim().toLowerCase(),
    normalBalance: (cells.normal_balance ?? cells.balance ?? "").trim().toLowerCase(),
    parentCode: blank(cells.parent_code ?? cells.parent),
    vatDefault: blank(cells.vat_default ?? cells.vat)?.toLowerCase() ?? null,
    description: blank(cells.description),
  };
}

export type CoaImportOutcome =
  | { rowNumber: number; code: string; status: "new"; row: CoaImportRow }
  | { rowNumber: number; code: string; status: "updated"; row: CoaImportRow; changedFields: string[] }
  | { rowNumber: number; code: string | null; status: "unchanged"; row: CoaImportRow }
  | { rowNumber: number; code: string | null; status: "error"; message: string; row: CoaImportRow };

const codeKey = (code: string) => code.trim().toLowerCase();

/**
 * Cross-file duplicates and each row's existing-account comparison, in one
 * pass. Parent codes must resolve to an account ALREADY in the entity's
 * chart — a chart importing new parent/child pairs defined only within the
 * same file is not supported here; state the parents first, or add them to
 * the chart directly, then import the children in a second file.
 */
export function validateCoaImportRows(rows: CoaImportRow[], existingAccounts: LedgerAccount[]): CoaImportOutcome[] {
  const existingByCode = new Map(existingAccounts.map((account) => [codeKey(account.code), account]));
  const seenInFile = new Map<string, number>();

  return rows.map((row) => {
    if (!row.code) return { rowNumber: row.rowNumber, code: null, status: "error", message: "Missing account code.", row };
    if (!row.name) return { rowNumber: row.rowNumber, code: row.code, status: "error", message: "Missing account name.", row };

    const key = codeKey(row.code);
    const firstSeenAt = seenInFile.get(key);
    if (firstSeenAt !== undefined) {
      return { rowNumber: row.rowNumber, code: row.code, status: "error", message: `Duplicate code in this file — also on row ${firstSeenAt}.`, row };
    }
    seenInFile.set(key, row.rowNumber);

    if (!ACCOUNT_TYPES.includes(row.accountType as AccountType)) {
      return { rowNumber: row.rowNumber, code: row.code, status: "error", message: `"${row.accountType || "(blank)"}" is not a recognised account type.`, row };
    }
    if (!NORMAL_BALANCES.includes(row.normalBalance as NormalBalance)) {
      return { rowNumber: row.rowNumber, code: row.code, status: "error", message: `"${row.normalBalance || "(blank)"}" must be debit or credit.`, row };
    }
    if (row.vatDefault && !VAT_DEFAULTS.includes(row.vatDefault)) {
      return { rowNumber: row.rowNumber, code: row.code, status: "error", message: `"${row.vatDefault}" is not a recognised VAT default.`, row };
    }
    if (row.parentCode) {
      if (codeKey(row.parentCode) === key) {
        return { rowNumber: row.rowNumber, code: row.code, status: "error", message: "An account cannot be its own parent.", row };
      }
      if (!existingByCode.has(codeKey(row.parentCode))) {
        return { rowNumber: row.rowNumber, code: row.code, status: "error", message: `Parent code "${row.parentCode}" does not exist in this entity's chart.`, row };
      }
    }

    const existing = existingByCode.get(key);
    if (!existing) {
      return { rowNumber: row.rowNumber, code: row.code, status: "new", row };
    }

    // account_type and normal_balance are load-bearing for every report that
    // reads this account — an import must not be able to retype an account
    // that already has history. Correcting one means deactivating and
    // recreating (§11), the same as any other chart edit.
    if (existing.accountType !== row.accountType) {
      return {
        rowNumber: row.rowNumber, code: row.code, status: "error",
        message: `Cannot change an existing account's type (${existing.accountType} → ${row.accountType}). Deactivate and recreate it instead.`, row,
      };
    }
    if (existing.normalBalance !== row.normalBalance) {
      return {
        rowNumber: row.rowNumber, code: row.code, status: "error",
        message: `Cannot change an existing account's normal balance (${existing.normalBalance} → ${row.normalBalance}). Deactivate and recreate it instead.`, row,
      };
    }

    const changedFields: string[] = [];
    if (existing.name !== row.name) changedFields.push("name");
    if ((existing.vatDefault ?? null) !== (row.vatDefault ?? null)) changedFields.push("vat_default");
    if ((existing.description ?? null) !== (row.description ?? null)) changedFields.push("description");

    if (!changedFields.length) {
      return { rowNumber: row.rowNumber, code: row.code, status: "unchanged", row };
    }
    return { rowNumber: row.rowNumber, code: row.code, status: "updated", changedFields, row };
  });
}

export function summariseCoaOutcomes(outcomes: CoaImportOutcome[]) {
  return {
    total: outcomes.length,
    newCount: outcomes.filter((o) => o.status === "new").length,
    updatedCount: outcomes.filter((o) => o.status === "updated").length,
    unchangedCount: outcomes.filter((o) => o.status === "unchanged").length,
    errorCount: outcomes.filter((o) => o.status === "error").length,
  };
}

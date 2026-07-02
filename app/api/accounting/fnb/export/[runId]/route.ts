import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import type { AccountingRunDetail, AccountingTransaction } from "@/lib/accounting/types";

type ExportSection =
  | "all"
  | "transactions"
  | "review-items"
  | "summary"
  | "bank-reconciliation"
  | "vat"
  | "general-ledger"
  | "trial-balance";

const sectionNames: Record<ExportSection, string> = {
  all: "workbook",
  transactions: "transactions",
  "review-items": "review-items",
  summary: "summary",
  "bank-reconciliation": "bank-reconciliation",
  vat: "vat",
  "general-ledger": "general-ledger",
  "trial-balance": "trial-balance",
};

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: unknown[][]) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function money(value: number | null | undefined) {
  return value ?? "";
}

function reviewItems(transactions: AccountingTransaction[]) {
  return transactions.filter(
    (transaction) =>
      transaction.reviewStatus === "needs_review" ||
      transaction.vatTreatment === "review" ||
      transaction.accountCategory === "Review Required" ||
      transaction.accountCategory === "Uncategorised Expense" ||
      transaction.confidence < 80,
  );
}

function accountGroups(transactions: AccountingTransaction[]) {
  const groups = new Map<string, { debit: number; credit: number; count: number }>();
  for (const transaction of transactions) {
    const account = transaction.reviewStatus === "approved" ? transaction.accountCategory : "Review Required Suspense";
    const current = groups.get(account) ?? { debit: 0, credit: 0, count: 0 };
    current.debit += transaction.debitAmount ?? 0;
    current.credit += transaction.creditAmount ?? 0;
    current.count += 1;
    groups.set(account, current);
  }
  return Array.from(groups, ([account, values]) => ({ account, ...values })).sort((a, b) => a.account.localeCompare(b.account));
}

function csvForSection(detail: AccountingRunDetail, section: ExportSection) {
  const transactions = detail.transactions;
  const totalDebits = transactions.reduce((sum, transaction) => sum + (transaction.debitAmount ?? 0), 0);
  const totalCredits = transactions.reduce((sum, transaction) => sum + (transaction.creditAmount ?? 0), 0);
  const expectedClosing = (detail.run.openingBalance ?? 0) + totalCredits - totalDebits;
  const difference = expectedClosing - (detail.run.closingBalance ?? 0);

  if (section === "transactions") {
    return csv([
      ["Date", "Description", "Money In", "Money Out", "Balance", "Bank Charge", "Account", "VAT", "Review Status", "Confidence"],
      ...transactions.map((transaction) => [
        transaction.transactionDate,
        transaction.description,
        money(transaction.creditAmount),
        money(transaction.debitAmount),
        money(transaction.runningBalance),
        transaction.bankCharge ? money(transaction.debitAmount) : "",
        transaction.accountCategory,
        transaction.vatTreatment,
        transaction.reviewStatus,
        transaction.confidence,
      ]),
    ]);
  }

  if (section === "review-items") {
    return csv([
      ["Date", "Description", "Money In", "Money Out", "Account", "VAT", "Review Status", "Confidence", "Notes"],
      ...reviewItems(transactions).map((transaction) => [
        transaction.transactionDate,
        transaction.description,
        money(transaction.creditAmount),
        money(transaction.debitAmount),
        transaction.accountCategory,
        transaction.vatTreatment,
        transaction.reviewStatus,
        transaction.confidence,
        transaction.notes,
      ]),
    ]);
  }

  if (section === "summary") {
    return csv([
      ["Metric", "Value"],
      ["Company", detail.run.companyName ?? ""],
      ["Account number", detail.run.accountNumber ?? ""],
      ["Statement period start", detail.run.statementPeriodStart ?? ""],
      ["Statement period end", detail.run.statementPeriodEnd ?? ""],
      ["Opening balance", money(detail.run.openingBalance)],
      ["Total receipts", totalCredits],
      ["Total payments", totalDebits],
      ["Closing balance", money(detail.run.closingBalance)],
      ["Transactions extracted", transactions.length],
      ["Review items", reviewItems(transactions).length],
      ["Confidence", detail.run.confidence],
    ]);
  }

  if (section === "bank-reconciliation") {
    return csv([
      ["Bank Reconciliation", "Amount"],
      ["Opening Balance", money(detail.run.openingBalance)],
      ["+ Receipts", totalCredits],
      ["- Payments", totalDebits],
      ["= Expected Closing Balance", expectedClosing],
      ["Statement Closing Balance", money(detail.run.closingBalance)],
      ["Difference", difference],
      ["Status", Math.abs(difference) < 0.01 ? "Reconciled" : "Review required"],
      ["Service Fees", detail.run.bankChargesTotal],
      ["Bank VAT", detail.run.bankChargesTotal * (15 / 115)],
    ]);
  }

  if (section === "vat") {
    return csv([
      ["Date", "Description", "Money In", "Money Out", "Account", "VAT Treatment", "Review Status"],
      ...transactions.map((transaction) => [
        transaction.transactionDate,
        transaction.description,
        money(transaction.creditAmount),
        money(transaction.debitAmount),
        transaction.reviewStatus === "approved" ? transaction.accountCategory : "Review Required Suspense",
        transaction.reviewStatus === "approved" ? transaction.vatTreatment : "review",
        transaction.reviewStatus,
      ]),
    ]);
  }

  const groups = accountGroups(transactions);
  if (section === "general-ledger") {
    return csv([
      ["Account", "Transactions", "Debits", "Credits", "Net Movement"],
      ...groups.map((group) => [group.account, group.count, group.debit, group.credit, group.credit - group.debit]),
    ]);
  }

  return csv([
    ["Account", "Total Debits", "Total Credits", "Debit Balance", "Credit Balance"],
    ...groups.map((group) => {
      const net = group.debit - group.credit;
      return [group.account, group.debit, group.credit, net > 0 ? net : 0, net < 0 ? Math.abs(net) : 0];
    }),
  ]);
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const requestedSection = new URL(request.url).searchParams.get("section") as ExportSection | null;
  const section: ExportSection = requestedSection && requestedSection in sectionNames ? requestedSection : "all";

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    if (section !== "all") {
      const body = csvForSection(detail, section);
      const fileName = `FNB-${sectionNames[section]}-${detail.run.id.slice(0, 8)}.csv`;
      return new NextResponse(body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    if (!detail.run.workbookStoragePath) {
      return NextResponse.json({ error: "The Excel workbook is not ready yet." }, { status: 409 });
    }

    const { data, error } = await context.supabase.storage.from("documents").download(detail.run.workbookStoragePath);
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "Workbook not found." }, { status: 404 });
    }

    const fileName = `FNB-accounting-workbook-${detail.run.id.slice(0, 8)}.xlsx`;
    return new NextResponse(data, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to export workbook." },
      { status: 500 },
    );
  }
}

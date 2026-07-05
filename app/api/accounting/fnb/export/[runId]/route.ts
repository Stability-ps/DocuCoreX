import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import {
  buildExportSections,
  resolveCompanyName,
  sectionToCsv,
  sectionsToXlsx,
  type ExportSection,
  type ExportSectionId,
} from "@/lib/accounting/export";

// Single-section CSV downloads.
const CSV_SECTIONS: Record<string, ExportSectionId> = {
  transactions: "transactions",
  "review-items": "review-items",
  summary: "summary",
  "bank-reconciliation": "bank-reconciliation",
  vat: "vat",
  "general-ledger": "general-ledger",
  "trial-balance": "trial-balance",
  "chart-of-accounts": "chart-of-accounts",
  vat201: "vat201",
  "review-queue": "review-queue",
  "exception-report": "exception-report",
};

// Grouped / full multi-sheet XLSX packs.
const XLSX_PACKS: Record<string, ExportSectionId[]> = {
  "financial-statements": ["profit-loss", "balance-sheet", "cash-flow", "financial-statements"],
  "ai-insights": ["ai-categorisation", "review-queue", "ai-intelligence", "tax-vat"],
  "audit-pack": ["cover", "audit-tools", "lead-schedules", "exception-report", "review-queue", "reconciliation-issues", "tax-vat", "assumptions"],
  vat: ["vat", "vat201"],
  // Full professional accounting pack (Big-Four sheet order).
  all: [
    "cover",
    "summary",
    "data-quality",
    "extraction-log",
    "transactions",
    "ai-categorisation",
    "review-queue",
    "chart-of-accounts",
    "general-ledger",
    "trial-balance",
    "profit-loss",
    "balance-sheet",
    "cash-flow",
    "vat",
    "vat201",
    "bank-reconciliation",
    "reconciliation-issues",
    "financial-statements",
    "tax-vat",
    "ai-intelligence",
    "forecasting",
    "audit-tools",
    "lead-schedules",
    "exception-report",
    "assumptions",
  ],
};

function pickSections(all: ExportSection[], ids: ExportSectionId[]): ExportSection[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is ExportSection => Boolean(s));
}

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const section = new URL(request.url).searchParams.get("section") ?? "all";

  try {
    const context = await getWorkspaceContext();
    if (!context) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const detail = await getAccountingRunDetail(runId);
    if (!detail) {
      return NextResponse.json({ error: "Accounting run not found." }, { status: 404 });
    }

    let workspaceCompany: string | null = null;
    try {
      const { data } = await context.supabase
        .from("companies")
        .select("business_name")
        .eq("workspace_id", context.workspaceId)
        .eq("is_default", true)
        .maybeSingle();
      workspaceCompany = (data as { business_name?: string } | null)?.business_name ?? null;
    } catch {
      workspaceCompany = null;
    }
    const company = resolveCompanyName(detail.run.companyName, workspaceCompany);
    const sections = buildExportSections(detail, company);
    const shortId = detail.run.id.slice(0, 8);
    const slug = (company || "bank-statement").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "bank-statement";

    // Single-section CSV
    if (section in CSV_SECTIONS) {
      const target = pickSections(sections, [CSV_SECTIONS[section]])[0];
      const body = sectionToCsv(target);
      const fileName = `${slug}-${section}-${shortId}.csv`;
      return new NextResponse(body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    // Grouped / full XLSX pack
    const packIds = XLSX_PACKS[section] ?? XLSX_PACKS.all;
    const packSections = pickSections(sections, packIds);
    const xlsx = sectionsToXlsx(packSections);
    const packLabel = section === "all" ? "accounting-pack" : section;
    const fileName = `${slug}-${packLabel}-${shortId}.xlsx`;

    return new NextResponse(Buffer.from(xlsx), {
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

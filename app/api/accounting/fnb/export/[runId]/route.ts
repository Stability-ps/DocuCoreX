import { NextResponse } from "next/server";
import { getAccountingRunDetail } from "@/lib/accounting/server";
import { getWorkspaceContext } from "@/lib/server-documents";
import {
  buildExportSections,
  resolveCompanyName,
  sectionsToXlsx,
  EXPORT_MENU,
  FULL_PACK_SECTIONS,
  type ExportSection,
  type ExportSectionId,
} from "@/lib/accounting/export";

// Every export the modal offers maps to a section id (single-sheet XLSX) or the
// full pack. Built from the shared EXPORT_MENU so the UI and route never drift.
const SECTION_BY_KEY: Record<string, ExportSectionId | "all"> = Object.fromEntries(
  EXPORT_MENU.map((option) => [option.key, option.section]),
);

function pickSections(all: ExportSection[], ids: ExportSectionId[]): ExportSection[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is ExportSection => Boolean(s));
}

function finalExportBlocked(detail: Awaited<ReturnType<typeof getAccountingRunDetail>>) {
  return Boolean(detail?.run.requiresReview || detail?.run.validationStatus === "review_required" || detail?.run.status === "review");
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
    if (section === "all" && finalExportBlocked(detail)) {
      return NextResponse.json(
        { error: "Final export is blocked until reconciliation and transaction-count review items are resolved. Download individual sections for draft review." },
        { status: 409 },
      );
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

    // Resolve the requested export: full pack, or a single section (styled XLSX).
    const resolved = SECTION_BY_KEY[section] ?? "all";
    const packIds = resolved === "all" ? FULL_PACK_SECTIONS : [resolved];
    const packSections = pickSections(sections, packIds);
    if (!packSections.length) {
      return NextResponse.json({ error: "Requested export is not available for this statement." }, { status: 404 });
    }
    const xlsx = sectionsToXlsx(packSections);
    const packLabel = resolved === "all" ? "accounting-pack" : resolved;
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

import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { deleteCompany, getCompany, updateCompany } from "@/lib/companies";
import type { CompanyProfileAction, CompanyProfileInput } from "@/lib/companies";

const validActions: CompanyProfileAction[] = ["setDefault", "archive", "unarchive"];

type PatchBody = Partial<CompanyProfileInput> & { action?: string };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await getCompany(id);

  if (!company) {
    return NextResponse.json({ error: "Company profile not found" }, { status: 404 });
  }

  return NextResponse.json({ company });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as PatchBody;
  const action = validActions.includes(body.action as CompanyProfileAction) ? (body.action as CompanyProfileAction) : undefined;

  const maxLogoDataUrlLength = 400_000; // ~300KB base64, enough for a resized logo thumbnail

  if (body.logoDataUrl && body.logoDataUrl.length > maxLogoDataUrlLength) {
    return NextResponse.json({ error: "Logo image is too large. Use a smaller image." }, { status: 400 });
  }

  try {
    const { action: _action, ...patch } = body;
    const company = await updateCompany(id, patch, action);

    if (!company) {
      return NextResponse.json({ error: "Company profile not found" }, { status: 404 });
    }

    await recordAuditLog({
      action: action ? `company_profile_${action.toLowerCase()}` : "company_profile_updated",
      entityType: "company",
      entityId: id,
      metadata: { businessName: company.businessName },
    });

    return NextResponse.json({ company });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update company profile" }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = await deleteCompany(id);

  if (!deleted) {
    return NextResponse.json({ error: "Company profile not found" }, { status: 404 });
  }

  await recordAuditLog({
    action: "company_profile_deleted",
    entityType: "company",
    entityId: id,
  });

  return NextResponse.json({ success: true });
}

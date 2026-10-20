import { NextResponse } from "next/server";
import { routeErrorResponse } from "@/lib/api-errors";
import { recordAuditLog } from "@/lib/audit";
import { createCompany, listCompanies } from "@/lib/companies";
import type { CompanyProfileInput } from "@/lib/companies";

export async function GET() {
  try {
    return NextResponse.json({ companies: await listCompanies() });
  } catch (error) {
    return routeErrorResponse("docucorex.companies.list_failed", error, { message: "Unable to load company profiles." });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CompanyProfileInput;

  if (!body.businessName?.trim()) {
    return NextResponse.json({ error: "Business name is required" }, { status: 400 });
  }

  const maxLogoDataUrlLength = 400_000; // ~300KB base64, enough for a resized logo thumbnail

  if (body.logoDataUrl && body.logoDataUrl.length > maxLogoDataUrlLength) {
    return NextResponse.json({ error: "Logo image is too large. Use a smaller image." }, { status: 400 });
  }

  try {
    const company = await createCompany(body);

    await recordAuditLog({
      action: "company_profile_created",
      entityType: "company",
      entityId: company.id,
      metadata: { businessName: company.businessName, isDefault: company.isDefault },
    });

    return NextResponse.json({ company });
  } catch (error) {
    return routeErrorResponse("docucorex.companies.create_failed", error, { message: "Unable to create the company profile. Please try again." });
  }
}

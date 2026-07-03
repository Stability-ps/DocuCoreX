import { getWorkspaceContext } from "@/lib/server-documents";
import { companies, companyInvoiceSequences } from "@/lib/mock-repository";
import type { CompanyProfile, InvoicePaymentTerms } from "@/lib/types";

// ---------------------------------------------------------------------------
// Row <-> record mapping (Supabase snake_case rows <-> camelCase records)
// ---------------------------------------------------------------------------

type CompanyRow = {
  id: string;
  workspace_id: string;
  is_default: boolean;
  is_archived: boolean;
  logo_data_url: string | null;
  business_name: string;
  trading_name: string | null;
  vat_number: string | null;
  registration_number: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  physical_address: string | null;
  postal_address: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  bank_swift: string | null;
  payment_reference: string | null;
  default_currency: string;
  default_vat_rate: number;
  default_payment_terms: string;
  default_notes: string | null;
  default_terms: string | null;
  next_invoice_number: number;
  created_at: string;
  updated_at: string;
};

function mapCompanyRow(row: CompanyRow): CompanyProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isDefault: row.is_default,
    isArchived: row.is_archived,
    logoDataUrl: row.logo_data_url,
    businessName: row.business_name,
    tradingName: row.trading_name,
    vatNumber: row.vat_number,
    registrationNumber: row.registration_number,
    email: row.email,
    phone: row.phone,
    website: row.website,
    physicalAddress: row.physical_address,
    postalAddress: row.postal_address,
    bankName: row.bank_name,
    bankAccountHolder: row.bank_account_holder,
    bankAccountNumber: row.bank_account_number,
    bankBranchCode: row.bank_branch_code,
    bankSwift: row.bank_swift,
    paymentReference: row.payment_reference,
    defaultCurrency: row.default_currency,
    defaultVatRate: Number(row.default_vat_rate),
    defaultPaymentTerms: row.default_payment_terms as InvoicePaymentTerms,
    defaultNotes: row.default_notes,
    defaultTerms: row.default_terms,
    nextInvoiceNumber: row.next_invoice_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CompanyProfileInput = {
  logoDataUrl?: string | null;
  businessName: string;
  tradingName?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  physicalAddress?: string | null;
  postalAddress?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  bankBranchCode?: string | null;
  bankSwift?: string | null;
  paymentReference?: string | null;
  defaultCurrency?: string | null;
  defaultVatRate?: number | null;
  defaultPaymentTerms?: string | null;
  defaultNotes?: string | null;
  defaultTerms?: string | null;
  isDefault?: boolean;
};

const validPaymentTerms = ["due_on_receipt", "7_days", "14_days", "30_days", "60_days", "90_days"];

function cleanPaymentTerms(value?: string | null): InvoicePaymentTerms {
  return (validPaymentTerms.includes(value ?? "") ? value : "due_on_receipt") as InvoicePaymentTerms;
}

// ---------------------------------------------------------------------------
// Dual-mode data functions (mock store fallback vs Supabase), mirroring the
// pattern used in lib/invoices.ts.
// ---------------------------------------------------------------------------

export async function listCompanies(): Promise<CompanyProfile[]> {
  const context = await getWorkspaceContext();

  if (!context) {
    return [...companies].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  const { data, error } = await context.supabase
    .from("companies")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data as CompanyRow[]).map(mapCompanyRow);
}

export async function getCompany(id: string): Promise<CompanyProfile | null> {
  const context = await getWorkspaceContext();

  if (!context) {
    return companies.find((company) => company.id === id) ?? null;
  }

  const { data, error } = await context.supabase.from("companies").select("*").eq("workspace_id", context.workspaceId).eq("id", id).single();

  if (error || !data) {
    return null;
  }

  return mapCompanyRow(data as CompanyRow);
}

async function unsetOtherDefaults(excludeId?: string) {
  const context = await getWorkspaceContext();

  if (!context) {
    companies.forEach((company) => {
      if (company.id !== excludeId) company.isDefault = false;
    });
    return;
  }

  let query = context.supabase.from("companies").update({ is_default: false }).eq("workspace_id", context.workspaceId).eq("is_default", true);

  if (excludeId) {
    query = query.neq("id", excludeId);
  }

  await query;
}

export async function createCompany(input: CompanyProfileInput): Promise<CompanyProfile> {
  if (!input.businessName?.trim()) {
    throw new Error("Business name is required.");
  }

  const context = await getWorkspaceContext();
  const nowIso = new Date().toISOString();
  const existing = await listCompanies();
  const makeDefault = input.isDefault ?? existing.filter((company) => !company.isArchived).length === 0;
  const defaultPaymentTerms = cleanPaymentTerms(input.defaultPaymentTerms);

  if (makeDefault) {
    await unsetOtherDefaults();
  }

  if (!context) {
    const record: CompanyProfile = {
      id: `company_${Date.now()}`,
      workspaceId: "workspace_demo",
      isDefault: makeDefault,
      isArchived: false,
      logoDataUrl: input.logoDataUrl || null,
      businessName: input.businessName.trim(),
      tradingName: input.tradingName?.trim() || null,
      vatNumber: input.vatNumber?.trim() || null,
      registrationNumber: input.registrationNumber?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      physicalAddress: input.physicalAddress?.trim() || null,
      postalAddress: input.postalAddress?.trim() || null,
      bankName: input.bankName?.trim() || null,
      bankAccountHolder: input.bankAccountHolder?.trim() || null,
      bankAccountNumber: input.bankAccountNumber?.trim() || null,
      bankBranchCode: input.bankBranchCode?.trim() || null,
      bankSwift: input.bankSwift?.trim() || null,
      paymentReference: input.paymentReference?.trim() || null,
      defaultCurrency: input.defaultCurrency?.trim() || "ZAR",
      defaultVatRate: Number.isFinite(input.defaultVatRate) ? Number(input.defaultVatRate) : 15,
      defaultPaymentTerms,
      defaultNotes: input.defaultNotes?.trim() || null,
      defaultTerms: input.defaultTerms?.trim() || null,
      nextInvoiceNumber: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    companies.unshift(record);
    companyInvoiceSequences[record.id] = 1;

    return record;
  }

  const { data, error } = await context.supabase
    .from("companies")
    .insert({
      workspace_id: context.workspaceId,
      is_default: makeDefault,
      logo_data_url: input.logoDataUrl || null,
      business_name: input.businessName.trim(),
      trading_name: input.tradingName?.trim() || null,
      vat_number: input.vatNumber?.trim() || null,
      registration_number: input.registrationNumber?.trim() || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      website: input.website?.trim() || null,
      physical_address: input.physicalAddress?.trim() || null,
      postal_address: input.postalAddress?.trim() || null,
      bank_name: input.bankName?.trim() || null,
      bank_account_holder: input.bankAccountHolder?.trim() || null,
      bank_account_number: input.bankAccountNumber?.trim() || null,
      bank_branch_code: input.bankBranchCode?.trim() || null,
      bank_swift: input.bankSwift?.trim() || null,
      payment_reference: input.paymentReference?.trim() || null,
      default_currency: input.defaultCurrency?.trim() || "ZAR",
      default_vat_rate: Number.isFinite(input.defaultVatRate) ? Number(input.defaultVatRate) : 15,
      default_payment_terms: defaultPaymentTerms,
      default_notes: input.defaultNotes?.trim() || null,
      default_terms: input.defaultTerms?.trim() || null,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to create company profile");
  }

  return mapCompanyRow(data as CompanyRow);
}

export type CompanyProfileAction = "setDefault" | "archive" | "unarchive";

export async function updateCompany(
  id: string,
  patch: Partial<CompanyProfileInput>,
  action?: CompanyProfileAction,
): Promise<CompanyProfile | null> {
  const context = await getWorkspaceContext();
  const nowIso = new Date().toISOString();

  if (action === "setDefault") {
    await unsetOtherDefaults(id);
  }

  if (!context) {
    const company = companies.find((candidate) => candidate.id === id);

    if (!company) {
      return null;
    }

    if (patch.businessName !== undefined) company.businessName = patch.businessName.trim();
    if (patch.tradingName !== undefined) company.tradingName = patch.tradingName?.trim() || null;
    if (patch.vatNumber !== undefined) company.vatNumber = patch.vatNumber?.trim() || null;
    if (patch.registrationNumber !== undefined) company.registrationNumber = patch.registrationNumber?.trim() || null;
    if (patch.email !== undefined) company.email = patch.email?.trim() || null;
    if (patch.phone !== undefined) company.phone = patch.phone?.trim() || null;
    if (patch.website !== undefined) company.website = patch.website?.trim() || null;
    if (patch.physicalAddress !== undefined) company.physicalAddress = patch.physicalAddress?.trim() || null;
    if (patch.postalAddress !== undefined) company.postalAddress = patch.postalAddress?.trim() || null;
    if (patch.bankName !== undefined) company.bankName = patch.bankName?.trim() || null;
    if (patch.bankAccountHolder !== undefined) company.bankAccountHolder = patch.bankAccountHolder?.trim() || null;
    if (patch.bankAccountNumber !== undefined) company.bankAccountNumber = patch.bankAccountNumber?.trim() || null;
    if (patch.bankBranchCode !== undefined) company.bankBranchCode = patch.bankBranchCode?.trim() || null;
    if (patch.bankSwift !== undefined) company.bankSwift = patch.bankSwift?.trim() || null;
    if (patch.paymentReference !== undefined) company.paymentReference = patch.paymentReference?.trim() || null;
    if (patch.defaultCurrency !== undefined) company.defaultCurrency = patch.defaultCurrency?.trim() || "ZAR";
    if (patch.defaultVatRate !== undefined) company.defaultVatRate = Number(patch.defaultVatRate) || 0;
    if (patch.defaultPaymentTerms !== undefined) company.defaultPaymentTerms = cleanPaymentTerms(patch.defaultPaymentTerms);
    if (patch.defaultNotes !== undefined) company.defaultNotes = patch.defaultNotes?.trim() || null;
    if (patch.defaultTerms !== undefined) company.defaultTerms = patch.defaultTerms?.trim() || null;
    if (patch.logoDataUrl !== undefined) company.logoDataUrl = patch.logoDataUrl || null;
    if (action === "setDefault") company.isDefault = true;
    if (action === "archive") {
      company.isArchived = true;
      company.isDefault = false;
    }
    if (action === "unarchive") company.isArchived = false;
    company.updatedAt = nowIso;

    return company;
  }

  const dbPatch: Record<string, unknown> = { updated_at: nowIso };
  if (patch.businessName !== undefined) dbPatch.business_name = patch.businessName.trim();
  if (patch.tradingName !== undefined) dbPatch.trading_name = patch.tradingName?.trim() || null;
  if (patch.vatNumber !== undefined) dbPatch.vat_number = patch.vatNumber?.trim() || null;
  if (patch.registrationNumber !== undefined) dbPatch.registration_number = patch.registrationNumber?.trim() || null;
  if (patch.email !== undefined) dbPatch.email = patch.email?.trim() || null;
  if (patch.phone !== undefined) dbPatch.phone = patch.phone?.trim() || null;
  if (patch.website !== undefined) dbPatch.website = patch.website?.trim() || null;
  if (patch.physicalAddress !== undefined) dbPatch.physical_address = patch.physicalAddress?.trim() || null;
  if (patch.postalAddress !== undefined) dbPatch.postal_address = patch.postalAddress?.trim() || null;
  if (patch.bankName !== undefined) dbPatch.bank_name = patch.bankName?.trim() || null;
  if (patch.bankAccountHolder !== undefined) dbPatch.bank_account_holder = patch.bankAccountHolder?.trim() || null;
  if (patch.bankAccountNumber !== undefined) dbPatch.bank_account_number = patch.bankAccountNumber?.trim() || null;
  if (patch.bankBranchCode !== undefined) dbPatch.bank_branch_code = patch.bankBranchCode?.trim() || null;
  if (patch.bankSwift !== undefined) dbPatch.bank_swift = patch.bankSwift?.trim() || null;
  if (patch.paymentReference !== undefined) dbPatch.payment_reference = patch.paymentReference?.trim() || null;
  if (patch.defaultCurrency !== undefined) dbPatch.default_currency = patch.defaultCurrency?.trim() || "ZAR";
  if (patch.defaultVatRate !== undefined) dbPatch.default_vat_rate = Number(patch.defaultVatRate) || 0;
  if (patch.defaultPaymentTerms !== undefined) dbPatch.default_payment_terms = cleanPaymentTerms(patch.defaultPaymentTerms);
  if (patch.defaultNotes !== undefined) dbPatch.default_notes = patch.defaultNotes?.trim() || null;
  if (patch.defaultTerms !== undefined) dbPatch.default_terms = patch.defaultTerms?.trim() || null;
  if (patch.logoDataUrl !== undefined) dbPatch.logo_data_url = patch.logoDataUrl || null;
  if (action === "setDefault") dbPatch.is_default = true;
  if (action === "archive") {
    dbPatch.is_archived = true;
    dbPatch.is_default = false;
  }
  if (action === "unarchive") dbPatch.is_archived = false;

  const { data, error } = await context.supabase
    .from("companies")
    .update(dbPatch)
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !data) {
    return null;
  }

  return mapCompanyRow(data as CompanyRow);
}

export async function deleteCompany(id: string): Promise<boolean> {
  const context = await getWorkspaceContext();

  if (!context) {
    const index = companies.findIndex((candidate) => candidate.id === id);
    if (index === -1) return false;
    companies.splice(index, 1);
    delete companyInvoiceSequences[id];
    return true;
  }

  const { error } = await context.supabase.from("companies").delete().eq("workspace_id", context.workspaceId).eq("id", id);

  return !error;
}

// ---------------------------------------------------------------------------
// Per-company sequential invoice numbering: INV-000001, INV-000002, ... —
// every company profile has its own independent sequence (see
// migration 009_company_profiles.sql).
// ---------------------------------------------------------------------------
export async function nextCompanyInvoiceSequence(companyId: string): Promise<number> {
  const context = await getWorkspaceContext();

  if (!context) {
    const current = companyInvoiceSequences[companyId] ?? 1;
    companyInvoiceSequences[companyId] = current + 1;
    const company = companies.find((candidate) => candidate.id === companyId);
    if (company) company.nextInvoiceNumber = current + 1;
    return current;
  }

  const { data, error } = await context.supabase.rpc("next_company_invoice_sequence", { p_company_id: companyId });

  if (error || typeof data !== "number") {
    throw new Error(error?.message ?? "Unable to generate the next invoice number");
  }

  return data;
}

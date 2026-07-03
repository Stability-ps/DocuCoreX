"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, Building2, Copy, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import type { CompanyProfile } from "@/lib/types";

const paymentTermsOptions = [
  { value: "due_on_receipt", label: "Due on receipt" },
  { value: "7_days", label: "Net 7 days" },
  { value: "14_days", label: "Net 14 days" },
  { value: "30_days", label: "Net 30 days" },
  { value: "60_days", label: "Net 60 days" },
  { value: "90_days", label: "Net 90 days" },
];

type FormState = {
  businessName: string;
  tradingName: string;
  vatNumber: string;
  registrationNumber: string;
  email: string;
  phone: string;
  website: string;
  physicalAddress: string;
  postalAddress: string;
  bankName: string;
  bankAccountHolder: string;
  bankAccountNumber: string;
  bankBranchCode: string;
  bankSwift: string;
  paymentReference: string;
  defaultCurrency: string;
  defaultVatRate: string;
  defaultPaymentTerms: string;
  defaultNotes: string;
  defaultTerms: string;
};

const emptyForm: FormState = {
  businessName: "",
  tradingName: "",
  vatNumber: "",
  registrationNumber: "",
  email: "",
  phone: "",
  website: "",
  physicalAddress: "",
  postalAddress: "",
  bankName: "",
  bankAccountHolder: "",
  bankAccountNumber: "",
  bankBranchCode: "",
  bankSwift: "",
  paymentReference: "",
  defaultCurrency: "ZAR",
  defaultVatRate: "15",
  defaultPaymentTerms: "due_on_receipt",
  defaultNotes: "",
  defaultTerms: "",
};

function companyToForm(company: CompanyProfile): FormState {
  return {
    businessName: company.businessName,
    tradingName: company.tradingName ?? "",
    vatNumber: company.vatNumber ?? "",
    registrationNumber: company.registrationNumber ?? "",
    email: company.email ?? "",
    phone: company.phone ?? "",
    website: company.website ?? "",
    physicalAddress: company.physicalAddress ?? "",
    postalAddress: company.postalAddress ?? "",
    bankName: company.bankName ?? "",
    bankAccountHolder: company.bankAccountHolder ?? "",
    bankAccountNumber: company.bankAccountNumber ?? "",
    bankBranchCode: company.bankBranchCode ?? "",
    bankSwift: company.bankSwift ?? "",
    paymentReference: company.paymentReference ?? "",
    defaultCurrency: company.defaultCurrency,
    defaultVatRate: String(company.defaultVatRate ?? 15),
    defaultPaymentTerms: company.defaultPaymentTerms,
    defaultNotes: company.defaultNotes ?? "",
    defaultTerms: company.defaultTerms ?? "",
  };
}

function maskAccountNumber(value: string | null) {
  if (!value) return null;
  const last4 = value.slice(-4);
  return `••••${last4}`;
}

export function CompanyProfilesManager() {
  const [companies, setCompanies] = useState<CompanyProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/companies");
      if (!response.ok) throw new Error("Unable to load company profiles");
      const data = (await response.json()) as { companies: CompanyProfile[] };
      setCompanies(data.companies);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load company profiles");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") === "1") {
      setIsFormOpen(true);
      setEditingId(null);
      setForm(emptyForm);
    }
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setIsFormOpen(true);
  }

  function openEdit(company: CompanyProfile) {
    setEditingId(company.id);
    setForm(companyToForm(company));
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function save() {
    if (!form.businessName.trim()) {
      setError("Business name is required.");
      return;
    }
    setIsSaving(true);
    setError("");

    const payload = {
      businessName: form.businessName,
      tradingName: form.tradingName || null,
      vatNumber: form.vatNumber || null,
      registrationNumber: form.registrationNumber || null,
      email: form.email || null,
      phone: form.phone || null,
      website: form.website || null,
      physicalAddress: form.physicalAddress || null,
      postalAddress: form.postalAddress || null,
      bankName: form.bankName || null,
      bankAccountHolder: form.bankAccountHolder || null,
      bankAccountNumber: form.bankAccountNumber || null,
      bankBranchCode: form.bankBranchCode || null,
      bankSwift: form.bankSwift || null,
      paymentReference: form.paymentReference || null,
      defaultCurrency: form.defaultCurrency || "ZAR",
      defaultVatRate: Number(form.defaultVatRate) || 0,
      defaultPaymentTerms: form.defaultPaymentTerms,
      defaultNotes: form.defaultNotes || null,
      defaultTerms: form.defaultTerms || null,
    };

    try {
      const response = await fetch(editingId ? `/api/companies/${editingId}` : "/api/companies", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Unable to save company profile");
      }
      await load();
      closeForm();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save company profile");
    } finally {
      setIsSaving(false);
    }
  }

  async function setDefault(id: string) {
    await fetch(`/api/companies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setDefault" }),
    });
    await load();
  }

  async function toggleArchive(company: CompanyProfile) {
    await fetch(`/api/companies/${company.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: company.isArchived ? "unarchive" : "archive" }),
    });
    await load();
  }

  async function duplicate(company: CompanyProfile) {
    await fetch("/api/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...companyToForm(company),
        businessName: `${company.businessName} (Copy)`,
        defaultVatRate: Number(company.defaultVatRate ?? 15),
        isDefault: false,
      }),
    });
    await load();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this company profile? This cannot be undone.")) return;
    await fetch(`/api/companies/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {companies.length ? `${companies.length} compan${companies.length === 1 ? "y" : "ies"} configured.` : "No company profiles yet."}
        </p>
        <button
          onClick={openCreate}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700"
        >
          <Plus className="h-4 w-4" /> Add company
        </button>
      </div>

      {error ? <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((key) => (
            <div key={key} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
          ))}
        </div>
      ) : companies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
          <Building2 className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          <p className="text-sm font-semibold text-slate-700">Set up your business profile to create professional invoices.</p>
          <button
            onClick={openCreate}
            className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700"
          >
            <Plus className="h-4 w-4" /> Create company profile
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {companies.map((company) => (
            <div
              key={company.id}
              className={`rounded-xl border p-4 sm:p-5 ${company.isArchived ? "border-slate-100 bg-slate-50 opacity-70" : "border-slate-200 bg-white"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-royal-50 text-sm font-bold text-royal-700">
                    {company.businessName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-slate-900">{company.businessName}</p>
                      {company.isDefault ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                          <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> Default
                        </span>
                      ) : null}
                      {company.isArchived ? (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Archived</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      {[company.vatNumber ? `VAT: ${company.vatNumber}` : null, company.email, company.phone].filter(Boolean).join(" • ") || "No details yet"}
                    </p>
                    {company.bankName ? (
                      <p className="mt-0.5 text-xs text-slate-400">
                        {company.bankName} {maskAccountNumber(company.bankAccountNumber)}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!company.isDefault && !company.isArchived ? (
                    <button
                      onClick={() => setDefault(company.id)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                    >
                      Set default
                    </button>
                  ) : null}
                  <button
                    onClick={() => openEdit(company)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    onClick={() => duplicate(company)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </button>
                  <button
                    onClick={() => toggleArchive(company)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                  >
                    {company.isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    {company.isArchived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    onClick={() => remove(company.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isFormOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={closeForm}>
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">{editingId ? "Edit company profile" : "Create company profile"}</h2>
              <button onClick={closeForm} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name" required value={form.businessName} onChange={(v) => setForm((f) => ({ ...f, businessName: v }))} />
              <Field label="Trading name" value={form.tradingName} onChange={(v) => setForm((f) => ({ ...f, tradingName: v }))} />
              <Field label="VAT number" value={form.vatNumber} onChange={(v) => setForm((f) => ({ ...f, vatNumber: v }))} />
              <Field label="Registration number" value={form.registrationNumber} onChange={(v) => setForm((f) => ({ ...f, registrationNumber: v }))} />
              <Field label="Business email" type="email" value={form.email} onChange={(v) => setForm((f) => ({ ...f, email: v }))} />
              <Field label="Phone number" value={form.phone} onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
              <Field label="Website" value={form.website} onChange={(v) => setForm((f) => ({ ...f, website: v }))} />
              <Field label="Payment reference format" value={form.paymentReference} onChange={(v) => setForm((f) => ({ ...f, paymentReference: v }))} />
              <Field
                label="Physical address"
                textarea
                value={form.physicalAddress}
                onChange={(v) => setForm((f) => ({ ...f, physicalAddress: v }))}
              />
              <Field label="Postal address" textarea value={form.postalAddress} onChange={(v) => setForm((f) => ({ ...f, postalAddress: v }))} />
            </div>

            <div className="mt-6 border-t border-slate-100 pt-5">
              <p className="mb-3 text-sm font-semibold text-slate-700">Banking details</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Bank name" value={form.bankName} onChange={(v) => setForm((f) => ({ ...f, bankName: v }))} />
                <Field label="Account holder" value={form.bankAccountHolder} onChange={(v) => setForm((f) => ({ ...f, bankAccountHolder: v }))} />
                <Field label="Account number" value={form.bankAccountNumber} onChange={(v) => setForm((f) => ({ ...f, bankAccountNumber: v }))} />
                <Field label="Branch code" value={form.bankBranchCode} onChange={(v) => setForm((f) => ({ ...f, bankBranchCode: v }))} />
                <Field label="SWIFT / BIC (optional)" value={form.bankSwift} onChange={(v) => setForm((f) => ({ ...f, bankSwift: v }))} />
              </div>
            </div>

            <div className="mt-6 border-t border-slate-100 pt-5">
              <p className="mb-3 text-sm font-semibold text-slate-700">Invoice defaults</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Default currency" value={form.defaultCurrency} onChange={(v) => setForm((f) => ({ ...f, defaultCurrency: v }))} />
                <Field label="Default VAT rate (%)" type="number" value={form.defaultVatRate} onChange={(v) => setForm((f) => ({ ...f, defaultVatRate: v }))} />
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600">Default payment terms</label>
                  <select
                    className="min-h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-royal-300 focus:bg-white"
                    value={form.defaultPaymentTerms}
                    onChange={(event) => setForm((f) => ({ ...f, defaultPaymentTerms: event.target.value }))}
                  >
                    {paymentTermsOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="Default notes to client" textarea value={form.defaultNotes} onChange={(v) => setForm((f) => ({ ...f, defaultNotes: v }))} />
                <Field
                  label="Default terms & conditions"
                  textarea
                  value={form.defaultTerms}
                  onChange={(v) => setForm((f) => ({ ...f, defaultTerms: v }))}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button onClick={closeForm} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={isSaving}
                className="rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:opacity-60"
              >
                {isSaving ? "Saving…" : editingId ? "Save changes" : "Create company profile"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  textarea = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  textarea?: boolean;
}) {
  return (
    <div className={textarea ? "sm:col-span-2" : undefined}>
      <label className="mb-1 block text-xs font-semibold text-slate-600">
        {label}
        {required ? " *" : ""}
      </label>
      {textarea ? (
        <textarea
          className="min-h-20 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-royal-300 focus:bg-white"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="min-h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-royal-300 focus:bg-white"
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

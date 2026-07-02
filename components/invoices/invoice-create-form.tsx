"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import { InvoicePreview } from "@/components/invoices/InvoicePreview";
import {
  calculateInvoiceFinalTotal,
  calculateInvoiceSubtotal,
  calculateInvoiceVatAmount,
  createEmptyInvoiceLineItem,
  formatCurrency,
  paymentTermsOptions,
} from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoicePaymentTerms, InvoiceRecord, InvoiceStatus } from "@/lib/types";

const inputClassName =
  "min-h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-royal-500 focus:ring-2 focus:ring-royal-100";
const labelClassName = "text-[11px] font-semibold uppercase tracking-wide text-slate-400";
const cardClassName = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
const sectionTitleClassName = "text-sm font-semibold text-slate-900";

const currencyOptions = ["ZAR", "USD", "EUR", "GBP"];
const bankAccountTypeOptions = ["Cheque", "Savings", "Current", "Transmission", "Business"];

// Resize an uploaded logo down to a small thumbnail and return it as a base64 data URL. Keeping
// logos small avoids needing a dedicated storage bucket/signed-URL pipeline for this feature —
// the data URL is stored directly on the invoice row.
function resizeImageToDataUrl(file: File, maxDimension = 240): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read the selected image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Unable to load the selected image."));
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");

        if (!context) {
          reject(new Error("Unable to process the selected image."));
          return;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png", 0.9));
      };
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function Field({ label, children, full = false }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={`space-y-1 ${full ? "sm:col-span-2" : ""}`}>
      <label className={labelClassName}>{label}</label>
      {children}
    </div>
  );
}

export function InvoiceCreateForm() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Business (issuer)
  const [issuerName, setIssuerName] = useState("");
  const [issuerTradingName, setIssuerTradingName] = useState("");
  const [issuerVatNumber, setIssuerVatNumber] = useState("");
  const [issuerRegistrationNumber, setIssuerRegistrationNumber] = useState("");
  const [issuerEmail, setIssuerEmail] = useState("");
  const [issuerPhone, setIssuerPhone] = useState("");
  const [issuerWebsite, setIssuerWebsite] = useState("");
  const [issuerAddress, setIssuerAddress] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState("");

  // Payment information
  const [bankName, setBankName] = useState("");
  const [bankAccountHolder, setBankAccountHolder] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankAccountType, setBankAccountType] = useState("Cheque");
  const [bankBranchCode, setBankBranchCode] = useState("");
  const [bankSwift, setBankSwift] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentInstructions, setPaymentInstructions] = useState("");

  // Client
  const [clientName, setClientName] = useState("");
  const [clientCompanyName, setClientCompanyName] = useState("");
  const [clientContactPerson, setClientContactPerson] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientVatNumber, setClientVatNumber] = useState("");
  const [clientRegistrationNumber, setClientRegistrationNumber] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [attentionTo, setAttentionTo] = useState("");
  const [clientReference, setClientReference] = useState("");
  const [paymentTerms, setPaymentTerms] = useState<InvoicePaymentTerms>("due_on_receipt");
  const [currency, setCurrency] = useState("ZAR");

  // Invoice details
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<InvoiceStatus>("draft");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState("");
  const [internalNotes, setInternalNotes] = useState("");

  // Line items & totals
  const [lineItems, setLineItems] = useState<InvoiceLineItemDraft[]>([createEmptyInvoiceLineItem()]);
  const [discountAmount, setDiscountAmount] = useState("0");
  const [shippingAmount, setShippingAmount] = useState("0");
  const [additionalCharges, setAdditionalCharges] = useState("0");

  // Notes & terms
  const [notesToClient, setNotesToClient] = useState("Thank you for your business.");
  const [termsAndConditions, setTermsAndConditions] = useState("");

  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Live totals — recomputed on every keystroke so the summary always reflects the current
  // line items, discount, shipping and additional charges. The server recomputes these again
  // from scratch on submit and never trusts client-sent totals.
  const subtotal = calculateInvoiceSubtotal(lineItems);
  const discountValue = Number(discountAmount || 0);
  const shippingValue = Number(shippingAmount || 0);
  const additionalValue = Number(additionalCharges || 0);
  const vatAmount = calculateInvoiceVatAmount(lineItems, discountAmount);
  const totalAmount = calculateInvoiceFinalTotal(lineItems, discountAmount, shippingAmount, additionalCharges);
  const amountAfterDiscount = Math.max(subtotal - discountValue, 0);
  const blendedVatRate = amountAfterDiscount > 0 ? (vatAmount / amountAfterDiscount) * 100 : 0;

  useEffect(() => {
    async function loadDefaultIssuer() {
      const response = await fetch("/api/profile");
      if (!response.ok) return;
      const data = (await response.json().catch(() => ({}))) as { profile?: { company?: string } };
      if (data.profile?.company) {
        setIssuerName((current) => current || data.profile!.company!);
      }
    }

    void loadDefaultIssuer();
  }, []);

  async function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setLogoError("Please choose an image file.");
      return;
    }

    try {
      setLogoError("");
      setLogoDataUrl(await resizeImageToDataUrl(file));
    } catch (resizeError) {
      setLogoError(resizeError instanceof Error ? resizeError.message : "Unable to process the selected image.");
    }
  }

  function validate(): boolean {
    setError("");

    if (!clientName.trim()) {
      setError("Client name is required.");
      return false;
    }

    const hasLineItem = lineItems.some((item) => item.serviceItem.trim() || Number(item.unitPrice || 0) > 0);

    if (!hasLineItem) {
      setError("Add at least one invoice line item.");
      return false;
    }

    return true;
  }

  function openPreview() {
    if (validate()) {
      setShowPreview(true);
    }
  }

  function buildPayload(finalStatus: InvoiceStatus) {
    const cleanPaymentInstructions = [bankAccountType ? `Account type: ${bankAccountType}` : "", paymentInstructions.trim()].filter(Boolean).join("\n");

    return {
      status: finalStatus,
      currency,
      invoiceDate,
      dueDate: dueDate || null,
      paymentTerms,
      referenceNumber,
      purchaseOrderNumber,
      internalNotes,
      clientName,
      clientCompanyName,
      clientContactPerson,
      clientEmail,
      clientPhone,
      clientAddress,
      clientPostalAddress: null,
      clientVatNumber,
      clientRegistrationNumber,
      attentionTo,
      clientReference,
      issuerName,
      issuerTradingName,
      issuerEmail,
      issuerPhone,
      issuerWebsite,
      issuerAddress,
      issuerPostalAddress: null,
      issuerVatNumber,
      issuerRegistrationNumber,
      logoDataUrl,
      bankName,
      bankAccountHolder,
      bankAccountNumber,
      bankBranchCode,
      bankSwift,
      paymentReference,
      paymentInstructions: cleanPaymentInstructions,
      title,
      description,
      discountAmount: Number(discountAmount || 0),
      shippingAmount: Number(shippingAmount || 0),
      additionalCharges: Number(additionalCharges || 0),
      notesToClient,
      termsAndConditions,
      lineItems,
    };
  }

  async function submit(finalStatus: InvoiceStatus) {
    if (!validate()) return;

    setError("");
    setIsSubmitting(true);

    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(finalStatus)),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Unable to create invoice.");
      setIsSubmitting(false);
      setShowPreview(false);
      return;
    }

    const data = (await response.json()) as { invoice: InvoiceRecord };
    router.push(`/invoices/${data.invoice.id}`);
  }

  const previewData = {
    title,
    description,
    status,
    currency,
    invoiceDate,
    dueDate,
    paymentTerms,
    referenceNumber,
    purchaseOrderNumber,
    internalNotes,
    clientName,
    clientCompanyName,
    clientContactPerson,
    clientEmail,
    clientPhone,
    clientAddress,
    clientPostalAddress: null,
    clientVatNumber,
    clientRegistrationNumber,
    attentionTo,
    clientReference,
    issuerName,
    issuerTradingName,
    issuerEmail,
    issuerPhone,
    issuerWebsite,
    issuerAddress,
    issuerVatNumber,
    issuerRegistrationNumber,
    logoDataUrl,
    bankName,
    bankAccountHolder,
    bankAccountNumber,
    bankBranchCode,
    bankSwift,
    paymentReference,
    paymentInstructions: [bankAccountType ? `Account type: ${bankAccountType}` : "", paymentInstructions.trim()].filter(Boolean).join("\n"),
    notesToClient,
    termsAndConditions,
    lineItems,
    discountAmount,
    shippingAmount,
    additionalCharges,
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-royal-700">Client invoicing</p>
          <h1 className="mt-0.5 text-xl font-semibold text-slate-900">Create invoice</h1>
          <p className="mt-0.5 text-xs text-slate-400">Create professional invoices for your clients.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-right">
            <p className={labelClassName}>Invoice number</p>
            <p className="font-mono text-sm font-semibold text-slate-900">Assigned on save</p>
          </div>
          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold capitalize text-slate-600">
            {status}
          </span>
        </div>
      </div>

      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

      {showPreview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
            <p className="text-xs font-semibold text-slate-500">Preview — nothing has been saved yet.</p>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => setShowPreview(false)}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300"
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={() => void submit("draft")}
                disabled={isSubmitting}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300 disabled:cursor-wait disabled:opacity-60"
              >
                Save draft
              </button>
              <button
                type="button"
                onClick={() => void submit("issued")}
                disabled={isSubmitting}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-royal-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-royal-700 disabled:cursor-wait disabled:bg-slate-300"
              >
                {isSubmitting ? "Creating…" : "Create invoice"}
              </button>
            </div>
          </div>

          <InvoicePreview invoice={previewData} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 1. Your business */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Your business</p>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50">
                  {logoDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL preview, not an optimizable static asset
                    <img src={logoDataUrl} alt="Logo preview" className="h-full w-full object-contain" />
                  ) : (
                    <ImagePlus className="h-5 w-5 text-slate-300" />
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-royal-300"
                  >
                    {logoDataUrl ? "Change logo" : "Upload logo"}
                  </button>
                  {logoDataUrl ? (
                    <button
                      type="button"
                      onClick={() => setLogoDataUrl(null)}
                      className="rounded-lg p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                      aria-label="Remove logo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
                {logoError ? <p className="text-[11px] font-semibold text-rose-600">{logoError}</p> : null}
              </div>
              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <Field label="Business name">
                  <input className={inputClassName} value={issuerName} onChange={(event) => setIssuerName(event.target.value)} placeholder="Your company name" />
                </Field>
                <Field label="Trading name (optional)">
                  <input className={inputClassName} value={issuerTradingName} onChange={(event) => setIssuerTradingName(event.target.value)} />
                </Field>
                <Field label="VAT registration number">
                  <input className={inputClassName} value={issuerVatNumber} onChange={(event) => setIssuerVatNumber(event.target.value)} />
                </Field>
                <Field label="Company registration number">
                  <input className={inputClassName} value={issuerRegistrationNumber} onChange={(event) => setIssuerRegistrationNumber(event.target.value)} />
                </Field>
                <Field label="Business email">
                  <input className={inputClassName} type="email" value={issuerEmail} onChange={(event) => setIssuerEmail(event.target.value)} />
                </Field>
                <Field label="Phone number">
                  <input className={inputClassName} value={issuerPhone} onChange={(event) => setIssuerPhone(event.target.value)} />
                </Field>
                <Field label="Website">
                  <input className={inputClassName} value={issuerWebsite} onChange={(event) => setIssuerWebsite(event.target.value)} placeholder="https://" />
                </Field>
                <div />
                <Field label="Physical address" full>
                  <input className={inputClassName} value={issuerAddress} onChange={(event) => setIssuerAddress(event.target.value)} />
                </Field>
              </div>
            </div>
          </section>

          {/* 2. Payment information */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Payment information</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Bank name">
                <input className={inputClassName} value={bankName} onChange={(event) => setBankName(event.target.value)} />
              </Field>
              <Field label="Account holder">
                <input className={inputClassName} value={bankAccountHolder} onChange={(event) => setBankAccountHolder(event.target.value)} />
              </Field>
              <Field label="Account number">
                <input className={inputClassName} value={bankAccountNumber} onChange={(event) => setBankAccountNumber(event.target.value)} />
              </Field>
              <Field label="Account type">
                <select className={inputClassName} value={bankAccountType} onChange={(event) => setBankAccountType(event.target.value)}>
                  {bankAccountTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Branch code">
                <input className={inputClassName} value={bankBranchCode} onChange={(event) => setBankBranchCode(event.target.value)} />
              </Field>
              <Field label="SWIFT / BIC (optional)">
                <input className={inputClassName} value={bankSwift} onChange={(event) => setBankSwift(event.target.value)} />
              </Field>
              <Field label="Payment reference">
                <input className={inputClassName} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} />
              </Field>
              <Field label="Payment instructions (optional)" full>
                <textarea className={`${inputClassName} min-h-16`} value={paymentInstructions} onChange={(event) => setPaymentInstructions(event.target.value)} />
              </Field>
            </div>
          </section>

          {/* 3. Client details */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Client details</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Client name">
                <input className={inputClassName} value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client or company name" />
              </Field>
              <Field label="Company name">
                <input className={inputClassName} value={clientCompanyName} onChange={(event) => setClientCompanyName(event.target.value)} />
              </Field>
              <Field label="Contact person">
                <input className={inputClassName} value={clientContactPerson} onChange={(event) => setClientContactPerson(event.target.value)} />
              </Field>
              <Field label="Attention to">
                <input className={inputClassName} value={attentionTo} onChange={(event) => setAttentionTo(event.target.value)} />
              </Field>
              <Field label="Email">
                <input className={inputClassName} type="email" value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="client@email.com" />
              </Field>
              <Field label="Phone">
                <input className={inputClassName} value={clientPhone} onChange={(event) => setClientPhone(event.target.value)} />
              </Field>
              <Field label="VAT number (optional)">
                <input className={inputClassName} value={clientVatNumber} onChange={(event) => setClientVatNumber(event.target.value)} />
              </Field>
              <Field label="Company registration number">
                <input className={inputClassName} value={clientRegistrationNumber} onChange={(event) => setClientRegistrationNumber(event.target.value)} />
              </Field>
              <Field label="Physical address" full>
                <input className={inputClassName} value={clientAddress} onChange={(event) => setClientAddress(event.target.value)} />
              </Field>
              <Field label="Client reference">
                <input className={inputClassName} value={clientReference} onChange={(event) => setClientReference(event.target.value)} />
              </Field>
              <Field label="Payment terms">
                <select className={inputClassName} value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value as InvoicePaymentTerms)}>
                  {paymentTermsOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          {/* 4. Invoice details */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Invoice details</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Title">
                <input className={inputClassName} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Professional services" />
              </Field>
              <Field label="Status">
                <select className={inputClassName} value={status} onChange={(event) => setStatus(event.target.value as InvoiceStatus)}>
                  {(["draft", "issued", "paid", "overdue", "cancelled"] as InvoiceStatus[]).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Invoice date">
                <input className={inputClassName} type="date" value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); event.currentTarget.blur(); }} />
              </Field>
              <Field label="Due date">
                <input className={inputClassName} type="date" value={dueDate} onChange={(event) => { setDueDate(event.target.value); event.currentTarget.blur(); }} />
              </Field>
              <Field label="Currency">
                <select className={inputClassName} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {currencyOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference number">
                <input className={inputClassName} value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} />
              </Field>
              <Field label="Purchase order">
                <input className={inputClassName} value={purchaseOrderNumber} onChange={(event) => setPurchaseOrderNumber(event.target.value)} placeholder="e.g. PO-12345" />
              </Field>
              <Field label="Description" full>
                <textarea className={`${inputClassName} min-h-16`} value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>
              <Field label="Internal notes (not shown to client)" full>
                <textarea className={`${inputClassName} min-h-16`} value={internalNotes} onChange={(event) => setInternalNotes(event.target.value)} />
              </Field>
            </div>
          </section>

          {/* 5. Line items */}
          <section className={cardClassName}>
            <InvoiceLineItemsEditor items={lineItems} currency={currency} onChange={setLineItems} />
          </section>

          {/* 6. Totals */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Totals</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field label="Discount">
                <input className={inputClassName} type="number" min="0" step="0.01" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} />
              </Field>
              <Field label="Shipping">
                <input className={inputClassName} type="number" min="0" step="0.01" value={shippingAmount} onChange={(event) => setShippingAmount(event.target.value)} />
              </Field>
              <Field label="Additional charges">
                <input className={inputClassName} type="number" min="0" step="0.01" value={additionalCharges} onChange={(event) => setAdditionalCharges(event.target.value)} />
              </Field>
            </div>

            <div className="ml-auto mt-4 max-w-xs space-y-1.5 rounded-xl bg-slate-50 p-4 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal</span>
                <span className="font-medium text-slate-900">{formatCurrency(subtotal, currency)}</span>
              </div>
              {discountValue > 0 ? (
                <div className="flex justify-between text-slate-600">
                  <span>Discount</span>
                  <span className="font-medium text-slate-900">-{formatCurrency(discountValue, currency)}</span>
                </div>
              ) : null}
              {shippingValue > 0 ? (
                <div className="flex justify-between text-slate-600">
                  <span>Shipping</span>
                  <span className="font-medium text-slate-900">{formatCurrency(shippingValue, currency)}</span>
                </div>
              ) : null}
              {additionalValue > 0 ? (
                <div className="flex justify-between text-slate-600">
                  <span>Additional charges</span>
                  <span className="font-medium text-slate-900">{formatCurrency(additionalValue, currency)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-slate-600">
                <span>VAT{blendedVatRate > 0 ? ` (${blendedVatRate.toFixed(1)}%)` : ""}</span>
                <span className="font-medium text-slate-900">{formatCurrency(vatAmount, currency)}</span>
              </div>
              <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-navy-950">
                <span>Total due</span>
                <span>{formatCurrency(totalAmount, currency)}</span>
              </div>
            </div>
          </section>

          {/* 7. Notes to client */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Notes to client</p>
            <textarea
              className={`${inputClassName} mt-3 min-h-16`}
              value={notesToClient}
              onChange={(event) => setNotesToClient(event.target.value)}
              placeholder="Thank you for your business."
            />
          </section>

          {/* 8. Terms & conditions */}
          <section className={cardClassName}>
            <p className={sectionTitleClassName}>Terms &amp; conditions</p>
            <textarea
              className={`${inputClassName} mt-3 min-h-20`}
              value={termsAndConditions}
              onChange={(event) => setTermsAndConditions(event.target.value)}
              placeholder="Payment due within 30 days. Interest may be charged on overdue invoices."
            />
          </section>

          <div className="sticky bottom-4 z-10 flex justify-end gap-2.5 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
            <button
              type="button"
              onClick={() => void submit("draft")}
              disabled={isSubmitting}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300 disabled:cursor-wait disabled:opacity-60"
            >
              Save draft
            </button>
            <button
              type="button"
              onClick={openPreview}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300"
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => void submit("issued")}
              disabled={isSubmitting}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-royal-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-royal-700 disabled:cursor-wait disabled:bg-slate-300"
            >
              {isSubmitting ? "Creating…" : "Create invoice"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

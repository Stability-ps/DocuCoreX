"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { InvoiceLineItemsEditor } from "@/components/invoices/InvoiceLineItemsEditor";
import { InvoicePreview } from "@/components/invoices/InvoicePreview";
import { createEmptyInvoiceLineItem } from "@/lib/invoice-utils";
import type { InvoiceLineItemDraft, InvoiceRecord, InvoiceStatus } from "@/lib/types";

const inputClassName =
  "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-royal-500 focus:ring-2 focus:ring-royal-100";
const labelClassName = "text-xs font-semibold uppercase tracking-wide text-slate-500";

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

export function InvoiceCreateForm() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [issuerName, setIssuerName] = useState("");
  const [issuerEmail, setIssuerEmail] = useState("");
  const [issuerPhone, setIssuerPhone] = useState("");
  const [issuerAddress, setIssuerAddress] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [taxRate, setTaxRate] = useState("15");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [bankDetails, setBankDetails] = useState("");
  const [notesToClient, setNotesToClient] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");
  const [status, setStatus] = useState<InvoiceStatus>("draft");
  const [lineItems, setLineItems] = useState<InvoiceLineItemDraft[]>([createEmptyInvoiceLineItem()]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

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

  function openPreview() {
    setError("");

    if (!clientName.trim()) {
      setError("Client name is required.");
      return;
    }

    const hasLineItem = lineItems.some((item) => item.serviceItem.trim() || Number(item.unitPrice || 0) > 0);

    if (!hasLineItem) {
      setError("Add at least one invoice line item.");
      return;
    }

    setShowPreview(true);
  }

  async function submit() {
    setError("");
    setIsSubmitting(true);

    const response = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName,
        clientEmail,
        clientPhone,
        clientAddress,
        issuerName,
        issuerEmail,
        issuerPhone,
        issuerAddress,
        logoDataUrl,
        title,
        description,
        dueDate: dueDate || null,
        taxRate: Number(taxRate || 0),
        discountAmount: Number(discountAmount || 0),
        bankDetails,
        notesToClient,
        termsAndConditions,
        status,
        lineItems,
      }),
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

  if (showPreview) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-slate-600">Preview — nothing has been saved yet.</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowPreview(false)}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-royal-300"
            >
              Back to edit
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isSubmitting}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-royal-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-royal-700 disabled:cursor-wait disabled:bg-slate-300"
            >
              {isSubmitting ? "Creating…" : "Confirm & create invoice"}
            </button>
          </div>
        </div>

        {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

        <InvoicePreview
          invoice={{
            title,
            description,
            status,
            clientName,
            clientEmail,
            clientPhone,
            clientAddress,
            issuerName,
            issuerEmail,
            issuerPhone,
            issuerAddress,
            logoDataUrl,
            bankDetails,
            notesToClient,
            termsAndConditions,
            dueDate,
            lineItems,
            taxRate,
            discountAmount,
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Your business details</h2>
        <p className="mt-1 text-sm text-slate-500">Shown at the top of the invoice, next to your logo.</p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50">
              {logoDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- user-uploaded data URL preview, not an optimizable static asset
                <img src={logoDataUrl} alt="Logo preview" className="h-full w-full object-contain" />
              ) : (
                <ImagePlus className="h-6 w-6 text-slate-300" />
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-royal-300"
              >
                {logoDataUrl ? "Change logo" : "Upload logo"}
              </button>
              {logoDataUrl ? (
                <button
                  type="button"
                  onClick={() => setLogoDataUrl(null)}
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  aria-label="Remove logo"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
            {logoError ? <p className="text-xs font-semibold text-rose-600">{logoError}</p> : null}
          </div>
          <div className="grid flex-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className={labelClassName}>Business name</label>
              <input className={inputClassName} value={issuerName} onChange={(event) => setIssuerName(event.target.value)} placeholder="Your company name" />
            </div>
            <div className="space-y-1.5">
              <label className={labelClassName}>Business email</label>
              <input className={inputClassName} type="email" value={issuerEmail} onChange={(event) => setIssuerEmail(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className={labelClassName}>Business phone</label>
              <input className={inputClassName} value={issuerPhone} onChange={(event) => setIssuerPhone(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className={labelClassName}>Business address</label>
              <input className={inputClassName} value={issuerAddress} onChange={(event) => setIssuerAddress(event.target.value)} />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Client details</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Client name</label>
            <input className={inputClassName} value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Acme Holdings" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Client email</label>
            <input className={inputClassName} type="email" value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="accounts@client.com" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Client phone</label>
            <input className={inputClassName} value={clientPhone} onChange={(event) => setClientPhone(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Due date</label>
            <input className={inputClassName} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className={labelClassName}>Client address</label>
            <input className={inputClassName} value={clientAddress} onChange={(event) => setClientAddress(event.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Invoice details</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Title</label>
            <input className={inputClassName} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Professional services" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Status</label>
            <select className={inputClassName} value={status} onChange={(event) => setStatus(event.target.value as InvoiceStatus)}>
              {(["draft", "issued", "paid", "overdue", "cancelled"] as InvoiceStatus[]).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <label className={labelClassName}>Description</label>
            <textarea className={`${inputClassName} min-h-24`} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <InvoiceLineItemsEditor items={lineItems} onChange={setLineItems} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Discount &amp; tax</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClassName}>Discount (R)</label>
            <input className={inputClassName} type="number" min="0" step="0.01" value={discountAmount} onChange={(event) => setDiscountAmount(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>VAT rate (%)</label>
            <input className={inputClassName} type="number" min="0" step="0.01" value={taxRate} onChange={(event) => setTaxRate(event.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Bank details &amp; notes</h2>
        <div className="mt-4 grid gap-4">
          <div className="space-y-1.5">
            <label className={labelClassName}>Bank details (shown on invoice)</label>
            <textarea className={`${inputClassName} min-h-20`} value={bankDetails} onChange={(event) => setBankDetails(event.target.value)} placeholder="Bank name | Account number | Branch code" />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Notes to client</label>
            <textarea className={`${inputClassName} min-h-20`} value={notesToClient} onChange={(event) => setNotesToClient(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClassName}>Terms and conditions</label>
            <textarea className={`${inputClassName} min-h-20`} value={termsAndConditions} onChange={(event) => setTermsAndConditions(event.target.value)} />
          </div>
        </div>
      </section>

      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={openPreview}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-royal-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-royal-700"
        >
          Preview invoice
        </button>
      </div>
    </div>
  );
}

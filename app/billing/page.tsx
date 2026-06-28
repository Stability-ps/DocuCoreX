import { CreditCard, FileText, Gauge, HardDrive, ReceiptText, ShieldCheck, Zap } from "lucide-react";
import { PageHeader, SectionPanel, StatusPill } from "@/components/ui";

function DisabledAction({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled
      title="Stripe billing is not configured yet"
      className="inline-flex cursor-not-allowed items-center justify-center rounded-2xl bg-slate-200 px-4 py-3 text-sm font-black text-slate-500"
    >
      {children}
    </button>
  );
}

export default function BillingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Billing & Subscription"
        title="Plan, usage and invoices"
        description="Review subscription status, storage usage, processing credits, invoices and payment method readiness."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <StatusPill>Active workspace</StatusPill>
                <h2 className="mt-4 text-3xl font-black text-navy-950">Free Plan</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
                  Core document management, uploads, OCR architecture and conversion workflows are enabled. Stripe billing is not connected yet.
                </p>
              </div>
              <div className="rounded-2xl bg-royal-50 p-3 text-royal-600">
                <CreditCard className="h-6 w-6" />
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <DisabledAction>Manage subscription</DisabledAction>
              <DisabledAction>Upgrade plan</DisabledAction>
            </div>
          </div>
          <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-1 h-5 w-5 text-amber-700" />
              <div>
                <h3 className="font-black text-amber-950">Stripe setup required</h3>
                <p className="mt-2 text-sm leading-6 text-amber-800">
                  Add Stripe keys and webhook configuration before live subscription management, upgrades and invoice downloads can be enabled.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {[
            ["Storage used", "0 GB", "Calculated from uploaded files", HardDrive],
            ["OCR credits", "Available", "Processing quotas are provider-ready", Zap],
            ["Exports", "0", "Invoice and export billing not connected", Gauge],
          ].map(([label, value, detail, Icon]) => (
            <article key={label as string} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <Icon className="h-5 w-5 text-royal-600" />
              <p className="mt-4 text-2xl font-black text-navy-950">{value as string}</p>
              <p className="mt-1 text-sm font-black text-slate-700">{label as string}</p>
              <p className="mt-2 text-sm text-slate-500">{detail as string}</p>
            </article>
          ))}
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <SectionPanel title="Invoices" description="Billing documents will appear here after Stripe is connected.">
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center">
              <FileText className="mx-auto h-7 w-7 text-slate-300" />
              <p className="mt-3 font-black text-navy-950">No invoices yet</p>
              <p className="mt-1 text-sm text-slate-500">Invoices are generated after paid billing is configured.</p>
            </div>
          </SectionPanel>
          <SectionPanel title="Payment Method" description="Payment controls are disabled until Stripe checkout is configured.">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <ReceiptText className="h-6 w-6 text-royal-600" />
              <p className="mt-4 font-black text-navy-950">No payment method on file</p>
              <p className="mt-1 text-sm leading-6 text-slate-500">Connect Stripe to add cards, manage invoices and enable subscription upgrades.</p>
              <div className="mt-5">
                <DisabledAction>Add payment method</DisabledAction>
              </div>
            </div>
          </SectionPanel>
        </div>
      </div>
    </>
  );
}

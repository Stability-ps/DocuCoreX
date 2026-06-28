import { CreditCard } from "lucide-react";
import { PlaceholderPage } from "@/components/placeholder-page";

export default function BillingPage() {
  return (
    <PlaceholderPage
      eyebrow="Billing & Subscription"
      title="Billing, subscription and usage"
      description="Manage plan details, invoices, OCR credits, storage limits and Stripe subscription settings."
      icon={CreditCard}
      status="Stripe-ready"
      capabilities={["Current plan overview", "Usage and storage summaries", "Invoice and payment-method area"]}
      actions={[{ label: "Open Settings Billing", href: "/settings/billing" }]}
    />
  );
}

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import { PageHeader, SectionPanel, StatusPill } from "@/components/ui";

type PlaceholderAction = {
  label: string;
  href: string;
};

export function PlaceholderPage({
  eyebrow,
  title,
  description,
  icon: Icon,
  status = "Planned workspace",
  actions = [],
  capabilities = [],
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  status?: string;
  actions?: PlaceholderAction[];
  capabilities?: string[];
}) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <SectionPanel title={title} description="Coming soon. This workflow is available as a routed workspace and will be enabled when the underlying provider or data model is connected.">
          <div className="grid gap-5 lg:grid-cols-[0.8fr_1fr]">
            <div className="rounded-3xl border border-royal-100 bg-royal-50 p-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-royal-600 shadow-sm">
                <Icon className="h-6 w-6" />
              </div>
              <div className="mt-5">
                <StatusPill>{status}</StatusPill>
                <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>
              </div>
            </div>
            <div className="grid gap-3">
              {(capabilities.length ? capabilities : ["Coming soon", "Access-controlled route", "Ready for provider connection"]).map((capability) => (
                <div key={capability} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <ArrowRight className="h-4 w-4 text-royal-600" />
                  <span className="text-sm font-black text-navy-950">{capability}</span>
                </div>
              ))}
            </div>
          </div>
          {actions.length ? (
            <div className="mt-6 flex flex-wrap gap-3">
              {actions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-royal-200 hover:text-royal-700"
                >
                  {action.label}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              ))}
            </div>
          ) : null}
        </SectionPanel>
      </div>
    </>
  );
}

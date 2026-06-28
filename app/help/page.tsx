import Link from "next/link";
import { BookOpen, Bug, ExternalLink, FileQuestion, Lightbulb, LifeBuoy, PlayCircle, RadioTower } from "lucide-react";
import { PageHeader, SectionPanel, StatusPill } from "@/components/ui";

const supportCards = [
  { title: "Documentation", detail: "Setup guides, upload workflows and provider configuration.", icon: BookOpen, href: "", comingSoon: true },
  { title: "Tutorials", detail: "Step-by-step walkthroughs for extraction, conversion and search.", icon: PlayCircle, href: "", comingSoon: true },
  { title: "Contact Support", detail: "Send support requests through the automations support form.", icon: LifeBuoy, href: "/settings/automations" },
  { title: "Report Bug", detail: "Capture a reproducible issue for the product team.", icon: Bug, href: "/settings/automations" },
  { title: "Feature Request", detail: "Request new inputs, outputs, integrations or workflows.", icon: Lightbulb, href: "/settings/automations" },
  { title: "System Status", detail: "Review app status and authentication diagnostics.", icon: RadioTower, href: "/debug/auth" },
];

export default function HelpPage() {
  return (
    <>
      <PageHeader
        eyebrow="Help & Support"
        title="Support hub"
        description="Find documentation, tutorials, support request paths, bug reporting, feature requests and system status."
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {supportCards.map((card) => (
            card.comingSoon ? (
              <div key={card.title} className="rounded-3xl border border-slate-200 bg-white p-5 opacity-80 shadow-sm" title="Coming soon">
                <div className="flex items-start justify-between gap-4">
                  <div className="rounded-2xl bg-slate-100 p-3 text-slate-500">
                    <card.icon className="h-6 w-6" />
                  </div>
                  <StatusPill>Coming soon</StatusPill>
                </div>
                <h2 className="mt-5 font-black text-navy-950">{card.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">{card.detail}</p>
              </div>
            ) : (
              <Link
                key={card.title}
                href={card.href}
                className="group rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-royal-200 hover:shadow-soft"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="rounded-2xl bg-royal-50 p-3 text-royal-600">
                    <card.icon className="h-6 w-6" />
                  </div>
                  <ExternalLink className="h-4 w-4 text-slate-300 transition group-hover:text-royal-600" />
                </div>
                <h2 className="mt-5 font-black text-navy-950">{card.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">{card.detail}</p>
              </Link>
            )
          ))}
        </section>

        <SectionPanel title="Support Readiness" description="Support channels are routed to existing DocuCoreX tools until a dedicated ticketing provider is connected.">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Authentication", "Available"],
              ["Workspace diagnostics", "Available"],
              ["Ticketing provider", "Coming soon"],
            ].map(([label, status]) => (
              <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <FileQuestion className="h-5 w-5 text-royal-600" />
                <p className="mt-3 text-sm font-black text-navy-950">{label}</p>
                <div className="mt-2">
                  <StatusPill>{status}</StatusPill>
                </div>
              </div>
            ))}
          </div>
        </SectionPanel>
      </div>
    </>
  );
}

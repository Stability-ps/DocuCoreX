import Link from "next/link";
import { ArrowRight, Clock, Upload } from "lucide-react";
import { DashboardLive } from "@/components/dashboard-live";
import { quickActions, recentActivity } from "@/lib/product-data";
import { PageHeader, PrimaryButton, SectionPanel } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const profileName = (await supabase?.from("profiles").select("full_name").limit(1).maybeSingle())?.data?.full_name ?? "Patric";

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={`Good morning, ${profileName}`}
        description="A premium command center for documents, OCR, extraction, conversion, exports, queues and subscription usage."
        action={
          <PrimaryButton href="/upload">
            <Upload className="h-5 w-5" />
            Upload Document
          </PrimaryButton>
        }
      />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <DashboardLive />

        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <SectionPanel title="Quick Actions" description="Start the workflows finance teams use every day.">
            <div className="grid gap-3 sm:grid-cols-2">
              {quickActions.map((action) => (
                <Link
                  key={action.label}
                  href={action.href}
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-royal-200 hover:bg-white hover:shadow-sm"
                >
                  <div className="flex items-center gap-4">
                    <div className="rounded-2xl bg-white p-3 text-royal-600 shadow-sm">
                      <action.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-navy-950">{action.label}</p>
                      <p className="text-sm text-slate-500">{action.description}</p>
                    </div>
                  </div>
                  <ArrowRight className="h-5 w-5 text-slate-300 transition group-hover:text-royal-600" />
                </Link>
              ))}
            </div>
          </SectionPanel>

          <SectionPanel title="Recent Activity" description="Processing events, team actions and export status.">
            <div className="space-y-3">
              {recentActivity.map((item) => (
                <div key={item.title} className="flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <div className="rounded-2xl bg-white p-2.5 text-royal-600 shadow-sm">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-navy-950">{item.title}</p>
                    <p className="text-sm text-slate-500">{item.meta}</p>
                  </div>
                  <div className="flex items-center gap-1 text-xs font-semibold text-slate-400">
                    <Clock className="h-3.5 w-3.5" />
                    {item.time}
                  </div>
                </div>
              ))}
            </div>
          </SectionPanel>
        </div>
      </div>
    </>
  );
}

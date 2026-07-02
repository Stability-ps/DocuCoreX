"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { intakeTypes } from "@/lib/product-data";

export function IntakeConsole() {
  return (
    <div className="space-y-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {intakeTypes.map((type) => (
          <Link
            key={type.title}
            href={type.target}
            className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-royal-200 hover:shadow-soft"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="rounded-2xl bg-royal-50 p-3 text-royal-600">
                <type.icon className="h-6 w-6" />
              </div>
              <ArrowRight className="h-5 w-5 text-slate-300 transition group-hover:text-royal-600" />
            </div>
            <h2 className="mt-5 text-lg font-semibold text-navy-950">{type.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">{type.detail}</p>
            <div className="mt-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              Auto-detection ready
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}

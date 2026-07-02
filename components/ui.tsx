import Link from "next/link";
import type { LucideIcon } from "lucide-react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="hidden flex-col gap-4 border-b border-slate-200 bg-white px-4 py-5 sm:px-6 md:flex lg:flex-row lg:items-center lg:justify-between lg:px-8">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-royal-700">{eyebrow}</p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">{title}</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-600">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="rounded-lg bg-slate-100 p-2 text-slate-600">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-lg font-semibold text-slate-900 sm:mt-4 sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs font-semibold text-slate-700 sm:text-sm">{label}</p>
      <p className="mt-2 hidden text-sm text-slate-500 sm:block">{detail}</p>
    </article>
  );
}

export function SectionPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {description ? <p className="mt-1 hidden text-sm leading-6 text-slate-500 sm:block">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function StatusPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-700">
      {children}
    </span>
  );
}

export function PrimaryButton({ children, href }: { children: React.ReactNode; href?: string }) {
  const className =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-royal-700";
  if (href) {
    return (
      <Link className={className} href={href}>
        {children}
      </Link>
    );
  }
  return <button className={className}>{children}</button>;
}

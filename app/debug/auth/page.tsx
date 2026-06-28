import Link from "next/link";
import { cookies, headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { isAuthRequired, isDemoAllowed, isSupabaseConfigured } from "@/lib/supabase";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export default async function AuthDiagnosticsPage() {
  const headerStore = await headers();
  const cookieStore = await cookies();
  const host = headerStore.get("host") ?? "unknown";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  const cookieNames = cookieStore.getAll().map((cookie) => cookie.name);
  const supabaseCookieNames = cookieNames.filter((name) => name.includes("sb-") || name.includes("supabase"));
  const supabase = await createSupabaseServerClient();

  let userEmail = "";
  let userId = "";
  let sessionPresent = false;
  let authError = "";
  let profileFound = false;
  let workspaceFound = false;
  let workspaceId = "";
  let profileError = "";

  if (supabase) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    sessionPresent = Boolean(user);
    authError = error?.message ?? "";
    userEmail = user?.email ?? "";
    userId = user?.id ?? "";

    if (user) {
      try {
        const bootstrap = await ensureUserWorkspace(user);
        profileFound = Boolean(bootstrap?.profile);
        workspaceFound = Boolean(bootstrap?.profile.workspace_id);
        workspaceId = bootstrap?.profile.workspace_id ?? "";
      } catch (error) {
        profileError = error instanceof Error ? error.message : "Workspace bootstrap failed";
      }
    }
  }

  const rows = [
    ["Current hostname", host],
    ["Current origin", `${proto}://${host}`],
    ["Supabase configured", yesNo(isSupabaseConfigured)],
    ["Supabase session present", yesNo(sessionPresent)],
    ["Supabase user email", userEmail || "none"],
    ["Supabase user id", userId || "none"],
    ["Profile found", yesNo(profileFound)],
    ["Workspace found", yesNo(workspaceFound)],
    ["Workspace id", workspaceId || "none"],
    ["Supabase cookies detected", yesNo(supabaseCookieNames.length > 0)],
    ["Supabase cookie names", supabaseCookieNames.length ? supabaseCookieNames.join(", ") : "none"],
    ["NEXT_PUBLIC_REQUIRE_AUTH", String(process.env.NEXT_PUBLIC_REQUIRE_AUTH ?? "unset")],
    ["Auth required effective", yesNo(isAuthRequired)],
    ["Demo mode active", yesNo(isDemoAllowed)],
    ["Route protection result", sessionPresent || !isAuthRequired ? "protected routes allowed" : "protected routes redirect to /login"],
    ["Auth error", authError || "none"],
    ["Profile/workspace error", profileError || "none"],
  ];

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.2em] text-royal-700">DocuCoreX diagnostics</p>
            <h1 className="mt-2 text-3xl font-black text-navy-950">Auth session status</h1>
            <p className="mt-2 text-sm text-slate-600">No secret values are shown. Cookie values are never printed.</p>
          </div>
          <Link href="/dashboard" className="rounded-2xl bg-navy-950 px-4 py-2 text-sm font-black text-white">
            Dashboard
          </Link>
        </div>

        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-soft">
          {rows.map(([label, value]) => (
            <div key={label} className="grid gap-2 border-b border-slate-100 px-5 py-4 last:border-b-0 sm:grid-cols-[240px_1fr]">
              <p className="text-sm font-black text-slate-600">{label}</p>
              <p className="break-words font-mono text-sm text-navy-950">{value}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function yesNo(value: boolean) {
  return value ? "yes" : "no";
}

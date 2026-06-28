import { notFound } from "next/navigation";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase-server";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseServiceRoleClient();
  const checks = {
    supabaseConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    authSessionPresent: false,
    profileFound: false,
    workspaceId: "Not available",
    storageBucketReachable: false,
    latestUploadResult: "No upload found",
  };

  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    checks.authSessionPresent = Boolean(user);

    if (user) {
      const bootstrap = await ensureUserWorkspace(user);
      checks.profileFound = Boolean(bootstrap?.profile.workspace_id);
      checks.workspaceId = bootstrap?.profile.workspace_id ?? "Not available";

      if (bootstrap?.profile.workspace_id) {
        const { data: upload } = await supabase
          .from("uploads")
          .select("file_name, status, created_at")
          .eq("workspace_id", bootstrap.profile.workspace_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        checks.latestUploadResult = upload ? `${upload.file_name} - ${upload.status}` : "No upload found";
      }
    }
  }

  if (admin) {
    const { data } = await admin.storage.getBucket("documents");
    checks.storageBucketReachable = Boolean(data);
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-700">Dev diagnostics</p>
        <h1 className="mt-3 text-3xl font-semibold">DocuCoreX Supabase status</h1>
        <div className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {Object.entries(checks).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-sm font-medium text-slate-600">{key}</span>
              <span className="text-right text-sm font-semibold text-slate-950">{String(value)}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

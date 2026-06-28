import { NextResponse } from "next/server";
import { isDemoAllowed } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

const demoProfile = {
  id: "user_demo",
  workspaceId: "workspace_demo",
  fullName: "Demo User",
  company: "DocuCoreX Workspace",
  role: "Owner",
  twoFactorEnabled: false,
};

export async function GET() {
  const supabase = await createSupabaseServerClient();

  // Only allow demo mode if Supabase is not configured AND we're in local development.
  if (!supabase) {
    if (isDemoAllowed) {
      return NextResponse.json({ profile: demoProfile, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured. Check your environment variables." }, { status: 503 });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // Supabase is configured — never fall back to demo. Require a real session.
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  if (error || !data?.workspace_id) {
    const bootstrapped = await ensureUserWorkspace(user);
    if (bootstrapped?.profile.workspace_id) {
      const profileResponse = await supabase.from("profiles").select("*").eq("id", user.id).single();
      data = profileResponse.data;
      error = profileResponse.error;
    }
  }

  if (error) {
    return NextResponse.json({ error: "Your workspace is not ready yet. Please refresh or contact support if this continues." }, { status: 500 });
  }

  return NextResponse.json({ profile: data, mode: "live" });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    fullName?: string;
    company?: string;
    role?: string;
    twoFactorEnabled?: boolean;
  };

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    if (isDemoAllowed) {
      return NextResponse.json({ profile: { ...demoProfile, ...body }, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // Supabase is configured — require a real session.
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("profiles")
    .update({
      full_name: body.fullName,
      company: body.company,
      role: body.role,
      two_factor_enabled: body.twoFactorEnabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ profile: data, mode: "live" });
}

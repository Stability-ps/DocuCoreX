import type { User } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase-server";

export type WorkspaceBootstrapResult = {
  profile: {
    id: string;
    workspace_id: string;
    full_name: string | null;
    company: string | null;
    role: string | null;
  };
  created: boolean;
};

export async function ensureUserWorkspace(user: User): Promise<WorkspaceBootstrapResult | null> {
  const admin = createSupabaseServiceRoleClient();

  if (!admin) {
    return null;
  }

  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id, workspace_id, full_name, company, role")
    .eq("id", user.id)
    .maybeSingle();

  if (existingProfile?.workspace_id) {
    await ensureTeamMember(existingProfile.workspace_id, user.id, user.email, "Owner");
    return { profile: existingProfile, created: false };
  }

  const company = typeof user.user_metadata?.company === "string" && user.user_metadata.company.trim()
    ? user.user_metadata.company.trim()
    : "DocuCoreX Workspace";
  const fullName = typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
    ? user.user_metadata.full_name.trim()
    : (user.email ?? "DocuCoreX User");

  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .insert({ name: company, owner_id: user.id })
    .select("id")
    .single();

  if (workspaceError || !workspace) {
    throw new Error(workspaceError?.message ?? "Unable to create workspace");
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .insert({
      id: user.id,
      workspace_id: workspace.id,
      full_name: fullName,
      company,
      role: "owner",
    })
    .select("id, workspace_id, full_name, company, role")
    .single();

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? "Unable to create profile");
  }

  await ensureTeamMember(profile.workspace_id, user.id, user.email, "Owner");
  return { profile, created: true };
}

async function ensureTeamMember(workspaceId: string, userId: string, email: string | undefined, role: string) {
  const admin = createSupabaseServiceRoleClient();

  if (!admin || !email) {
    return;
  }

  await admin.from("team_members").upsert(
    {
      workspace_id: workspaceId,
      user_id: userId,
      email,
      role,
      status: "Active",
    },
    { onConflict: "workspace_id,email" },
  );
}

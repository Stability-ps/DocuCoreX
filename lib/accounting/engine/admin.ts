import { getWorkspaceContext } from "@/lib/server-documents";

export async function assertWorkspaceAdmin() {
  const context = await getWorkspaceContext();
  if (!context) {
    throw new Error("Unauthorized");
  }

  const [workspaceOwner, teamMembership] = await Promise.all([
    context.supabase.from("workspaces").select("owner_id").eq("id", context.workspaceId).single(),
    context.supabase.from("team_members").select("role").eq("workspace_id", context.workspaceId).eq("user_id", context.userId).maybeSingle(),
  ]);

  const isOwner = workspaceOwner.data?.owner_id === context.userId;
  const role = String(teamMembership.data?.role ?? "").toLowerCase();
  const isAdminRole = role === "admin" || role === "owner";

  if (!isOwner && !isAdminRole) {
    throw new Error("Forbidden");
  }

  return context;
}

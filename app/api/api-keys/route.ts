import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { recordAuditLog } from "@/lib/audit";
import { apiKeys } from "@/lib/mock-repository";
import { isDemoAllowed, isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getWorkspaceContext } from "@/lib/server-documents";

export async function GET() {
  if (!isSupabaseConfigured) {
    if (isDemoAllowed) {
      return NextResponse.json({ apiKeys, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await context.supabase
    .from("api_keys")
    .select("id, name, last_four, last_used_at, revoked_at, created_at")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ apiKeys: data ?? [] });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const rawKey = `dcx_${randomBytes(24).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const lastFour = rawKey.slice(-4).toUpperCase();
  const supabase = await createSupabaseServerClient();

  if (!supabase && isDemoAllowed) {
    const apiKey = {
      id: `api_key_${Date.now()}`,
      name: body.name ?? "New API key",
      lastFour,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    apiKeys.unshift(apiKey);
    await recordAuditLog({ action: "api_key_created", entityType: "api_key", entityId: apiKey.id, metadata: { name: apiKey.name } });
    return NextResponse.json({
      mode: "demo",
      apiKey,
      secret: rawKey,
    });
  }

  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if ((userError || !user) && isDemoAllowed) {
    const apiKey = {
      id: `api_key_${Date.now()}`,
      name: body.name ?? "New API key",
      lastFour,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    apiKeys.unshift(apiKey);
    await recordAuditLog({ action: "api_key_created", entityType: "api_key", entityId: apiKey.id, metadata: { name: apiKey.name } });
    return NextResponse.json({
      mode: "demo",
      apiKey,
      secret: rawKey,
    });
  }

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.workspace_id) {
    if (isDemoAllowed) {
      return NextResponse.json({
        mode: "demo",
        apiKey: {
          id: `api_key_${Date.now()}`,
          name: body.name ?? "New API key",
          lastFour,
          createdAt: new Date().toISOString(),
        },
        secret: rawKey,
      });
    }

    return NextResponse.json({ error: profileError?.message ?? "Profile workspace not found" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      workspace_id: profile.workspace_id,
      name: body.name ?? "New API key",
      key_hash: keyHash,
      last_four: lastFour,
      created_by: user.id,
    })
    .select("id, name, last_four, created_at")
    .single();

  if (error) {
    if (isDemoAllowed) {
      return NextResponse.json({
        mode: "demo",
        apiKey: {
          id: `api_key_${Date.now()}`,
          name: body.name ?? "New API key",
          lastFour,
          createdAt: new Date().toISOString(),
        },
        secret: rawKey,
      });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await recordAuditLog({ action: "api_key_created", entityType: "api_key", entityId: data.id, metadata: { name: data.name } });

  return NextResponse.json({ apiKey: data, secret: rawKey });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: string; revoked?: boolean };

  if (!body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const revokedAt = body.revoked === false ? null : new Date().toISOString();

  if (!isSupabaseConfigured) {
    if (isDemoAllowed) {
      const key = apiKeys.find((item) => item.id === body.id);
      if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 });
      Object.assign(key, { revokedAt, revoked_at: revokedAt });
      await recordAuditLog({ action: revokedAt ? "api_key_revoked" : "api_key_created", entityType: "api_key", entityId: body.id });
      return NextResponse.json({ apiKey: key, mode: "demo" });
    }
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const context = await getWorkspaceContext().catch(() => null);
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Scope the revoke to this workspace so a key id from another workspace can
  // never be mutated (defense-in-depth on top of RLS).
  const { data, error } = await context.supabase
    .from("api_keys")
    .update({ revoked_at: revokedAt })
    .eq("id", body.id)
    .eq("workspace_id", context.workspaceId)
    .select("id, name, last_four, last_used_at, revoked_at, created_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  await recordAuditLog({ action: revokedAt ? "api_key_revoked" : "api_key_created", entityType: "api_key", entityId: data.id });

  return NextResponse.json({ apiKey: data });
}

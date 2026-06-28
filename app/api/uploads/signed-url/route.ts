import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isAuthRequired } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    fileName?: string;
    contentType?: string;
  };

  if (!body.fileName) {
    return NextResponse.json({ error: "fileName is required" }, { status: 400 });
  }

  const safeFileName = body.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    const path = `workspace_demo/documents/${randomUUID()}-${safeFileName}`;
    return NextResponse.json({
      mode: "demo",
      bucket: "documents",
      path,
      token: "demo-upload-token",
      signedUrl: `/api/uploads/demo/${path}`,
      contentType: body.contentType ?? "application/octet-stream",
    });
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if ((userError || !user) && !isAuthRequired) {
    const path = `workspace_demo/documents/${randomUUID()}-${safeFileName}`;
    return NextResponse.json({
      mode: "demo",
      bucket: "documents",
      path,
      token: "demo-upload-token",
      signedUrl: `/api/uploads/demo/${path}`,
      contentType: body.contentType ?? "application/octet-stream",
    });
  }

  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.workspace_id) {
    const bootstrapped = await ensureUserWorkspace(user);

    if (bootstrapped?.profile.workspace_id) {
      profile = { workspace_id: bootstrapped.profile.workspace_id };
      profileError = null;
    }
  }

  if (profileError || !profile?.workspace_id) {
    if (!isAuthRequired) {
      const path = `workspace_demo/documents/${randomUUID()}-${safeFileName}`;
      return NextResponse.json({
        mode: "demo",
        bucket: "documents",
        path,
        token: "demo-upload-token",
        signedUrl: `/api/uploads/demo/${path}`,
        contentType: body.contentType ?? "application/octet-stream",
      });
    }

    return NextResponse.json({ error: "Your workspace is not ready yet. Please refresh or contact support if this continues." }, { status: 500 });
  }

  const path = `${profile.workspace_id}/documents/${randomUUID()}-${safeFileName}`;
  const { data, error } = await supabase.storage.from("documents").createSignedUploadUrl(path);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    bucket: "documents",
    path,
    signedUrl: data.signedUrl,
    token: data.token,
    contentType: body.contentType ?? "application/octet-stream",
  });
}

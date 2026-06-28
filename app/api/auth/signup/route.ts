import { createSupabaseServerClient } from "@/lib/supabase-server";
import { getSiteUrl } from "@/lib/supabase";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { email, password } = await request.json();

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = await createSupabaseServerClient();

    if (!supabase) {
      return NextResponse.json(
        { error: "Authentication service not configured" },
        { status: 500 }
      );
    }

    const redirectUrl = `${getSiteUrl()}/auth/callback`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: { product: "DocuCoreX" },
      },
    });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    if (!data.user) {
      return NextResponse.json(
        { error: "Sign up failed" },
        { status: 400 }
      );
    }

    // If session was created immediately, ensure workspace
    if (data.session) {
      try {
        await ensureUserWorkspace(data.user);
      } catch (e) {
        console.error("[Auth Signup] Workspace bootstrap failed:", e);
      }
    }

    return NextResponse.json(
      {
        success: true,
        user: data.user,
        requiresEmailVerification: !data.session,
        message: "Account created. Check your inbox to verify your email address.",
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Auth Signup] Unexpected error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

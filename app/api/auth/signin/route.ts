import { createSupabaseServerClient } from "@/lib/supabase-server";
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

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 401 }
      );
    }

    if (!data.user) {
      return NextResponse.json(
        { error: "Authentication failed" },
        { status: 401 }
      );
    }

    // Ensure user workspace exists
    try {
      await ensureUserWorkspace(data.user);
    } catch (e) {
      console.error("[Auth API] Workspace bootstrap failed:", e);
      // Don't fail the auth just because workspace setup failed
    }

    return NextResponse.json(
      { success: true, user: data.user },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Auth API] Unexpected error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

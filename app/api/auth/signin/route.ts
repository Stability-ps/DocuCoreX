import { createServerClient } from "@supabase/ssr";
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
    // Use a mutable response so Supabase can set cookies directly on it
    const supabaseResponse = NextResponse.next({ request });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              supabaseResponse.cookies.set(name, value, options);
            });
          },
        },
      }
    );

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
    }

    // Build final response and copy the auth cookies Supabase set on supabaseResponse
    const response = NextResponse.json(
      { success: true, user: data.user },
      { status: 200 }
    );

    supabaseResponse.cookies.getAll().forEach(({ name, value }) => {
      response.cookies.set(name, value, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
      });
    });

    return response;
  } catch (error) {
    console.error("[Auth API] Unexpected error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}


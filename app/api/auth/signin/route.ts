import { createServerClient } from "@supabase/ssr";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import { NextRequest, NextResponse } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { dedupeCookies, setSupabaseAuthCookie } from "@/lib/auth-cookies";

export async function POST(request: NextRequest) {
  const { email, password } = await request.json();

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 }
    );
  }

  try {
    // Accumulate cookies Supabase wants to set
    const pendingCookies: Array<{ name: string; value: string; options: CookieOptions }> = [];

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      {
        cookies: {
          getAll() {
            return dedupeCookies(request.cookies.getAll());
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              pendingCookies.push({ name, value, options });
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

    // Build response and apply auth cookies from Supabase
    const response = NextResponse.json(
      { success: true, user: data.user },
      { status: 200 }
    );

    pendingCookies.forEach(({ name, value, options }) => {
      setSupabaseAuthCookie(response.cookies, { name, value, options });
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

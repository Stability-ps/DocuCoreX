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
    const redirectUrl = `${new URL(request.url).origin}/auth/callback`;
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

    const response = NextResponse.json(
      {
        success: true,
        user: data.user,
        requiresEmailVerification: !data.session,
        message: "Account created. Check your inbox to verify your email address.",
      },
      { status: 200 }
    );

    // Copy auth cookies set by Supabase onto the final response
    if (data.session) {
      pendingCookies.forEach(({ name, value, options }) => {
        setSupabaseAuthCookie(response.cookies, { name, value, options });
      });
    }

    return response;
  } catch (error) {
    console.error("[Auth Signup] Unexpected error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

import { createServerClient } from "@supabase/ssr";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import { NextRequest, NextResponse } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { dedupeCookies, setSupabaseAuthCookie } from "@/lib/auth-cookies";
import { enforceRateLimit } from "@/lib/shared-rate-limit";
import { signUpErrorResponse } from "@/lib/auth-errors";

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit("signup", { request }, "Too many sign-up attempts from this address. Try again later.");
  if (limited) return limited;

  const { email, password, fullName } = await request.json();

  const normalizedName = typeof fullName === "string" ? fullName.trim().replace(/\s+/g, " ") : "";

  if (!email || !password || !normalizedName) {
    return NextResponse.json(
      { error: "Full name, email and password are required" },
      { status: 400 }
    );
  }

  if (normalizedName.length < 2) {
    return NextResponse.json(
      { error: "Full name must be at least 2 characters." },
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
        data: { product: "DocuCoreX", full_name: normalizedName, name: normalizedName },
      },
    });

    if (error) {
      // Validation verdicts keep their wording; anything else (SMTP, a database
      // trigger) is logged and answered generically (lib/auth-errors.ts).
      const failure = signUpErrorResponse(error);
      console.warn("[Auth Signup] Sign-up refused:", { status: error.status ?? null, code: error.code ?? null, message: error.message });
      return NextResponse.json(
        { error: failure.message },
        { status: failure.status }
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

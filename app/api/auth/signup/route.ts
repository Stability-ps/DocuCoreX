import { createServerClient } from "@supabase/ssr";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import { NextRequest, NextResponse } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { dedupeCookies, setSupabaseAuthCookie } from "@/lib/auth-cookies";
import { enforceRateLimit } from "@/lib/shared-rate-limit";
import { isExistingAccountSignUpError, SIGN_UP_CHECK_INBOX_MESSAGE, signUpErrorResponse } from "@/lib/auth-errors";

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

    // An address that already has an account is answered exactly like a new
    // one awaiting verification, so sign-up does not reveal who is registered.
    // Supabase signals it either as an error or, with email confirmation on,
    // as a user with no identities.
    const existingAccount =
      (error && isExistingAccountSignUpError(error)) ||
      (!error && data.user && !data.session && Array.isArray(data.user.identities) && data.user.identities.length === 0);
    if (existingAccount) {
      console.info("[Auth Signup] Sign-up for an existing address answered neutrally");
      return checkInboxResponse();
    }

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

    if (!data.session) return checkInboxResponse();

    // No user object in the body: the client only needs to know it is signed in.
    const response = NextResponse.json(
      { success: true, requiresEmailVerification: false, message: "Account created." },
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

/** The one answer for a new address awaiting verification and an existing one. */
function checkInboxResponse() {
  return NextResponse.json(
    { success: true, requiresEmailVerification: true, message: SIGN_UP_CHECK_INBOX_MESSAGE },
    { status: 200 }
  );
}

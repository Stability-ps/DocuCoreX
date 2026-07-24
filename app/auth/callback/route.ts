import { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { isSupabaseConfigured } from "@/lib/supabase";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";
import { dedupeCookies, setSupabaseAuthCookie } from "@/lib/auth-cookies";
import { safeNextPath } from "@/lib/safe-redirect";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;
  const code = requestUrl.searchParams.get("code");
  // Only allow internal, same-origin redirect targets — never an attacker-supplied
  // absolute URL (open-redirect guard).
  const next = safeNextPath(requestUrl.searchParams.get("next"));

  try {
    if (!isSupabaseConfigured || !code) {
      if (process.env.NODE_ENV === "development") {
        console.log("[Auth Callback] Missing config or code", { isSupabaseConfigured, code });
      }
      return NextResponse.redirect(new URL(next, origin));
    }

    let redirectResponse = NextResponse.redirect(new URL(next, origin));
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
      },
    );

    const exchangeResult = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeResult.error) {
      if (process.env.NODE_ENV === "development") {
        console.error("[Auth Callback] Exchange error:", exchangeResult.error);
      }
      return NextResponse.redirect(new URL("/login?error=exchange_failed", origin));
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      if (process.env.NODE_ENV === "development") {
        console.error("[Auth Callback] No user after exchange");
      }
      return NextResponse.redirect(new URL("/login?error=no_user", origin));
    }

    if (process.env.NODE_ENV === "development") {
      console.log("[Auth Callback] User authenticated, ensuring workspace", { userId: user.id });
    }

    try {
      await ensureUserWorkspace(user);
    } catch (bootstrapError) {
      if (process.env.NODE_ENV === "development") {
        console.error("[Auth Callback] Workspace bootstrap failed:", bootstrapError);
      }
      console.error("[Auth Callback] Workspace setup issue (non-blocking):", bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
    }

    if (process.env.NODE_ENV === "development") {
      console.log("[Auth Callback] Redirecting to:", next);
    }

    redirectResponse = NextResponse.redirect(new URL(next, origin));
    pendingCookies.forEach(({ name, value, options }) => {
      setSupabaseAuthCookie(redirectResponse.cookies, { name, value, options }, false);
    });

    return redirectResponse;
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error("[Auth Callback] Unexpected error:", error);
    }
    const fallbackOrigin = new URL(request.url).origin;
    return NextResponse.redirect(new URL("/login?error=auth_failed", fallbackOrigin));
  }
}

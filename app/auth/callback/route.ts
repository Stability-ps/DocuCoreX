import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { ensureUserWorkspace } from "@/lib/workspace-bootstrap";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") || "/dashboard";

  try {
    if (!isSupabaseConfigured || !code) {
      if (process.env.NODE_ENV === "development") {
        console.log("[Auth Callback] Missing config or code", { isSupabaseConfigured, code });
      }
      return NextResponse.redirect(new URL(next, origin));
    }

    const supabase = await createSupabaseServerClient();

    const exchangeResult = await supabase?.auth.exchangeCodeForSession(code);
    if (exchangeResult?.error) {
      if (process.env.NODE_ENV === "development") {
        console.error("[Auth Callback] Exchange error:", exchangeResult.error);
      }
      return NextResponse.redirect(new URL("/login?error=exchange_failed", origin));
    }

    const {
      data: { user },
    } = (await supabase?.auth.getUser()) ?? { data: { user: null } };

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
    return NextResponse.redirect(new URL(next, origin));
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error("[Auth Callback] Unexpected error:", error);
    }
    const fallbackOrigin = new URL(request.url).origin;
    return NextResponse.redirect(new URL("/login?error=auth_failed", fallbackOrigin));
  }
}

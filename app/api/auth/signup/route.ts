import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { dedupeCookies } from "@/lib/auth-cookies";
import { enforceRateLimit } from "@/lib/shared-rate-limit";
import { handleSignUp, type SignUpAuthClient } from "@/lib/auth-signup";

// Sign-up never signs anyone in and never says whether the address already has
// an account: see lib/auth-signup.ts. The limit is keyed by client IP only, so
// it reads the same for every address.
export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit("signup", { request }, "Too many sign-up attempts from this address. Try again later.");
  if (limited) return limited;

  const body = await request.json().catch(() => null);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      cookies: {
        getAll() {
          return dedupeCookies(request.cookies.getAll());
        },
        // Deliberately dropped: sign-up responses never carry auth cookies.
        setAll() {},
      },
    }
  );

  try {
    return await handleSignUp(body, { client: supabase as unknown as SignUpAuthClient, origin: new URL(request.url).origin });
  } catch (error) {
    console.error("[Auth Signup] Unexpected error:", error);
    return NextResponse.json({ error: "An unexpected error occurred" }, { status: 500 });
  }
}

import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/shared-rate-limit";
import { handleSignUp, type SignUpAuthClient } from "@/lib/auth-signup";

// Sign-up never signs anyone in and never says whether the address already has
// an account: see lib/auth-signup.ts. The limit is keyed by client IP only, so
// it reads the same for every address.
export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit("signup", { request }, "Too many sign-up attempts from this address. Try again later.");
  if (limited) return limited;

  const body = await request.json().catch(() => null);

  // A private, in-memory cookie jar: the request's own cookies are never read
  // (a signed-in visitor's session must not be the one signed out below) and
  // nothing written here reaches the response, so sign-up never sets a cookie.
  // The new account's session lives only in this jar, which lets
  // handleSignUp revoke exactly that session.
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      cookies: {
        getAll() {
          return Array.from(jar, ([name, value]) => ({ name, value }));
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            if (value) jar.set(name, value);
            else jar.delete(name);
          }
        },
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

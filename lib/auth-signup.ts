// Email + password sign-up that never reveals whether an address is registered.
//
// Supabase answers sign-up differently for a new and an existing address:
//   - email confirmation OFF: a new address gets a session at once, an existing
//     one gets `user_already_exists`;
//   - email confirmation ON: a new address gets a user awaiting verification, an
//     existing one an obfuscated user with no identities.
// The route used to pass the first difference through (a session, auth cookies
// and "Account created." for a new address only). Now every accepted sign-up
// gets the same 200 body, never sets a cookie, and takes at least
// SIGN_UP_MIN_RESPONSE_MS, so status, body, cookies and timing say nothing about
// the address. A session Supabase opens for a new account is revoked here; the
// person signs in with the password they chose (the sign-in route and the auth
// callback bootstrap the workspace, so sign-up no longer does).
//
// Kept free of the Supabase client factory and the rate limiter so the unit
// tests can drive it with a fake client (tests/security/signup-enumeration.test.ts).

import { NextResponse } from "next/server";
import { isExistingAccountSignUpError, SIGN_UP_ACCEPTED_MESSAGE, signUpErrorResponse, type AuthErrorLike } from "@/lib/auth-errors";

/** Long enough to cover Supabase creating a user (password hashing, the profile trigger, session issue and revoke). */
export const SIGN_UP_MIN_RESPONSE_MS = 1500;

type SignUpResult = {
  data: { user: { identities?: unknown[] | null } | null; session: unknown | null } | null;
  error: (AuthErrorLike & object) | null;
};

export type SignUpAuthClient = {
  auth: {
    signUp(credentials: {
      email: string;
      password: string;
      options: { emailRedirectTo: string; data: Record<string, unknown> };
    }): Promise<SignUpResult>;
    signOut(options?: { scope?: "global" | "local" | "others" }): Promise<unknown>;
  };
};

export type SignUpDeps = {
  client: SignUpAuthClient;
  /** Origin of the request, for the verification link. */
  origin: string;
  minResponseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The one answer for every accepted sign-up: new, existing, awaiting verification or not. */
export function signUpAcceptedResponse() {
  return NextResponse.json({ success: true, message: SIGN_UP_ACCEPTED_MESSAGE }, { status: 200 });
}

/** Supabase's email-send limit is only reached by addresses that would get an email, i.e. new or unconfirmed ones. */
function isEmailSendRateLimit(error: AuthErrorLike) {
  return error?.code === "over_email_send_rate_limit";
}

export async function handleSignUp(body: unknown, deps: SignUpDeps): Promise<NextResponse> {
  const { email, password, fullName } = (body ?? {}) as { email?: unknown; password?: unknown; fullName?: unknown };
  const normalizedName = typeof fullName === "string" ? fullName.trim().replace(/\s+/g, " ") : "";

  // Input checks depend only on what was sent, never on the address being known.
  if (typeof email !== "string" || !email || typeof password !== "string" || !password || !normalizedName) {
    return NextResponse.json({ error: "Full name, email and password are required" }, { status: 400 });
  }
  if (normalizedName.length < 2) {
    return NextResponse.json({ error: "Full name must be at least 2 characters." }, { status: 400 });
  }

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const minResponseMs = deps.minResponseMs ?? SIGN_UP_MIN_RESPONSE_MS;
  const started = now();
  const respond = async (response: NextResponse) => {
    const remaining = minResponseMs - (now() - started);
    if (remaining > 0) await sleep(remaining);
    return response;
  };

  try {
    const { data, error } = await deps.client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${deps.origin}/auth/callback`,
        data: { product: "DocuCoreX", full_name: normalizedName, name: normalizedName },
      },
    });

    const existingAccount =
      (error && isExistingAccountSignUpError(error)) ||
      (!error && data?.user && !data.session && Array.isArray(data.user.identities) && data.user.identities.length === 0);
    if (existingAccount) {
      console.info("[Auth Signup] Sign-up for an existing address answered neutrally");
      return respond(signUpAcceptedResponse());
    }

    if (error && isEmailSendRateLimit(error)) {
      // Answering 429 here would single out addresses that trigger an email.
      console.warn("[Auth Signup] Supabase email send limit reached; answered neutrally", { status: error.status ?? null });
      return respond(signUpAcceptedResponse());
    }

    if (error) {
      // Weak password, invalid address, sign-ups disabled: Supabase checks these
      // before looking the address up. Anything else is logged and generic.
      const failure = signUpErrorResponse(error);
      console.warn("[Auth Signup] Sign-up refused:", { status: error.status ?? null, code: error.code ?? null, message: error.message });
      return respond(NextResponse.json({ error: failure.message }, { status: failure.status }));
    }

    if (!data?.user) {
      return respond(NextResponse.json({ error: "Account creation failed. Please try again." }, { status: 400 }));
    }

    if (data.session) {
      // Email confirmation is off, so Supabase signed the new account in. The
      // session never leaves the server: revoke it so no refresh token lingers.
      try {
        // local: revoke only this new session, never the account's others.
        await deps.client.auth.signOut({ scope: "local" });
      } catch (e) {
        console.warn("[Auth Signup] Could not revoke the sign-up session:", e instanceof Error ? e.message : e);
      }
    }

    return respond(signUpAcceptedResponse());
  } catch (error) {
    console.error("[Auth Signup] Unexpected error:", error);
    return respond(NextResponse.json({ error: "An unexpected error occurred" }, { status: 500 }));
  }
}

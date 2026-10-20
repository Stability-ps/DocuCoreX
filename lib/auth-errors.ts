// What a sign-in, sign-up or password-reset failure tells the person.
//
// The auth routes used to return Supabase's `error.message` verbatim. Sign-in
// then distinguished an unknown address from a wrong password on some
// configurations, and any unexpected Auth/GoTrue failure (a misconfigured SMTP
// relay, a database trigger) reached the login page as raw server text. These
// helpers keep the messages a person can act on — rate limits, a weak password,
// an unconfirmed address — and collapse everything else.
//
// Pure (no Supabase or next/server imports) so the login page and the unit
// tests can share them.

export type AuthErrorLike = { status?: number; code?: string; message?: string } | null | undefined;

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
export const PASSWORD_RESET_SENT_MESSAGE = "If an account exists for that email, we sent a link to reset the password. Check your inbox.";

const AUTH_RATE_LIMIT_MESSAGE = "Too many attempts. Wait a few minutes and try again.";

function isRateLimited(error: AuthErrorLike) {
  return error?.status === 429 || error?.code === "over_request_rate_limit" || error?.code === "over_email_send_rate_limit";
}

/** Sign-in: one answer for an unknown address and a wrong password. */
export function signInErrorResponse(error: AuthErrorLike): { message: string; status: number } {
  if (isRateLimited(error)) return { message: AUTH_RATE_LIMIT_MESSAGE, status: 429 };
  // Supabase only reports an unconfirmed address after the password matched, so
  // this says nothing to someone who does not already hold the credentials.
  if (error?.code === "email_not_confirmed") {
    return { message: "Confirm your email address before signing in. Check your inbox for the verification link.", status: 401 };
  }
  return { message: INVALID_CREDENTIALS_MESSAGE, status: 401 };
}

/**
 * What every accepted sign-up hears, whether the address is new or already has
 * an account (owner decision 2026-10-20: sign-up must not reveal which
 * addresses are registered). It promises nothing it cannot keep: a new address
 * gets a verification email, an existing one gets none, so the wording is
 * conditional and points existing users at sign-in and password reset.
 */
export const SIGN_UP_CHECK_INBOX_MESSAGE =
  "Check your inbox. If this email can be used for a new account, we sent a link to verify it. Already have an account? Sign in or reset your password.";

/** An "address already registered" refusal, which must be answered like a success. */
export function isExistingAccountSignUpError(error: AuthErrorLike) {
  // Older GoTrue responses carry no code, only the sentence.
  return error?.code === "user_already_exists" || error?.code === "email_exists" || /already registered/i.test(error?.message ?? "");
}

/**
 * Sign-up. Validation verdicts keep Supabase's wording, which is written for
 * people ("Password should be at least 8 characters."). An existing address is
 * not a failure here (see isExistingAccountSignUpError).
 */
export function signUpErrorResponse(error: AuthErrorLike): { message: string; status: number } {
  if (isRateLimited(error)) return { message: AUTH_RATE_LIMIT_MESSAGE, status: 429 };
  switch (error?.code) {
    case "weak_password":
      return { message: error?.message || "Choose a stronger password.", status: 400 };
    case "email_address_invalid":
      return { message: "Enter a valid email address.", status: 400 };
    case "validation_failed":
      return { message: "Check the email address and password and try again.", status: 400 };
    case "signup_disabled":
    case "email_provider_disabled":
      return { message: "New sign-ups are not available right now.", status: 403 };
    default:
      return { message: "Account creation failed. Please try again.", status: 400 };
  }
}

/**
 * Password reset. Success never says whether the address has an account; a
 * failure only distinguishes what the person can fix.
 */
export function passwordResetMessage(error: AuthErrorLike): string {
  if (!error) return PASSWORD_RESET_SENT_MESSAGE;
  if (isRateLimited(error)) return AUTH_RATE_LIMIT_MESSAGE;
  if (error.code === "email_address_invalid" || error.code === "validation_failed") return "Enter a valid email address.";
  return "We could not send the reset email. Please try again.";
}

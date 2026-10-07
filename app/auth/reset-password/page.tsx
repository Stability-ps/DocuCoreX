"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound } from "lucide-react";
import { supabase } from "@/lib/supabase";

// Where a password-recovery link lands. /auth/callback exchanges the link's code
// for a recovery session and sends the user here (next=/auth/reset-password);
// this page is where the new password is actually chosen. Before it existed the
// recovery link signed the user in and the password never changed.

const MIN_PASSWORD_LENGTH = 8;

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const linkError = searchParams.get("error");
  const [sessionState, setSessionState] = useState<"checking" | "ready" | "missing">("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "done"; message: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!supabase || linkError) {
      setSessionState("missing");
      return;
    }
    void supabase.auth.getUser().then(({ data }) => setSessionState(data.user ? "ready" : "missing"));
  }, [linkError]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || isSubmitting) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setStatus({ kind: "error", message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }
    if (password !== confirmPassword) {
      setStatus({ kind: "error", message: "The two passwords do not match." });
      return;
    }
    setIsSubmitting(true);
    setStatus(null);
    const { error } = await supabase.auth.updateUser({ password });
    setIsSubmitting(false);
    if (error) {
      setStatus({ kind: "error", message: error.message });
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setStatus({ kind: "done", message: "Your password has been changed. Use it the next time you sign in." });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-royal-50 text-royal-700">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-semibold text-navy-950">Choose a new password</h1>
        </div>

        {sessionState === "checking" ? (
          <p className="mt-6 text-sm text-slate-600" role="status">
            Checking your reset link…
          </p>
        ) : null}

        {sessionState === "missing" ? (
          <div className="mt-6 space-y-4" role="alert">
            <p className="flex items-start gap-2 text-sm font-semibold text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              This reset link is invalid or has expired. Request a new one and use the most recent email.
            </p>
            <Link href="/login?mode=forgot" className="inline-flex min-h-11 items-center rounded-xl bg-navy-950 px-4 text-sm font-semibold text-white">
              Request a new link
            </Link>
          </div>
        ) : null}

        {sessionState === "ready" && status?.kind !== "done" ? (
          <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <label htmlFor="new-password" className="text-sm font-semibold text-slate-700">
                New password
              </label>
              <div className="flex items-center rounded-xl border border-slate-200 bg-white px-3 focus-within:border-royal-400">
                <input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="min-h-11 flex-1 bg-transparent text-sm outline-none"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="text-slate-400"
                  aria-label="Show password"
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm-new-password" className="text-sm font-semibold text-slate-700">
                Confirm new password
              </label>
              <input
                id="confirm-new-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-royal-400"
                required
              />
            </div>
            {status?.kind === "error" ? (
              <p className="text-sm font-semibold text-red-700" role="alert">
                {status.message}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-11 w-full rounded-xl bg-navy-950 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isSubmitting ? "Saving…" : "Save new password"}
            </button>
          </form>
        ) : null}

        {status?.kind === "done" ? (
          <div className="mt-6 space-y-4" role="status">
            <p className="flex items-start gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {status.message}
            </p>
            <Link href="/dashboard" className="inline-flex min-h-11 items-center rounded-xl bg-navy-950 px-4 text-sm font-semibold text-white">
              Continue to dashboard
            </Link>
          </div>
        ) : null}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  );
}

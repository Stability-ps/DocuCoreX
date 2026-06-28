"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, useEffect } from "react";
import { ArrowRight, Check, Eye, EyeOff, KeyRound, LockKeyhole, Mail, ShieldCheck, AlertCircle } from "lucide-react";
import { getSiteUrl, isSupabaseConfigured, supabase } from "@/lib/supabase";
import { profileChecklist } from "@/lib/product-data";

function LoginContent() {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [callbackError, setCallbackError] = useState("");

  useEffect(() => {
    const error = searchParams.get("error");
    if (error) {
      const errorMessages: Record<string, string> = {
        exchange_failed: "Session exchange failed. Please try signing in again.",
        no_user: "Authentication completed but user not found. Please try again.",
        auth_failed: "Authentication failed. Please try again or continue to the dashboard.",
      };
      setCallbackError(errorMessages[error] || `Authentication error: ${error}`);
      if (process.env.NODE_ENV === "development") {
        console.error("[Login] Callback error:", error);
      }
    }
  }, [searchParams]);

  function enterDemoWorkspace() {
    setStatus("Opening the DocuCoreX product workspace.");
    window.location.href = "/dashboard";
  }

  async function handleEmailAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setStatus("");

    if (!supabase) {
      enterDemoWorkspace();
      return;
    }

    const redirectTo = `${getSiteUrl()}/auth/callback`;

    // For signin and signup, use server endpoints that properly handle cookies
    if (mode === "signin") {
      try {
        const response = await fetch("/api/auth/signin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          const error = await response.json();
          setStatus(`${error.error}. You can continue to the product workspace while Supabase is being set up.`);
          setIsSubmitting(false);
          return;
        }

        window.location.href = "/dashboard";
        return;
      } catch (error) {
        setStatus(
          `${error instanceof Error ? error.message : "Unknown error"}. You can continue to the product workspace while Supabase is being set up.`
        );
        setIsSubmitting(false);
        return;
      }
    }

    if (mode === "signup") {
      try {
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (!response.ok) {
          setStatus(`${data.error}. You can continue to the product workspace while Supabase is being set up.`);
          setIsSubmitting(false);
          return;
        }

        if (data.requiresEmailVerification) {
          setStatus("Account created. Check your inbox to verify your email address, or continue to the product workspace now.");
        } else {
          window.location.href = "/dashboard";
        }
        setIsSubmitting(false);
        return;
      } catch (error) {
        setStatus(
          `${error instanceof Error ? error.message : "Unknown error"}. You can continue to the product workspace while Supabase is being set up.`
        );
        setIsSubmitting(false);
        return;
      }
    }

    // For forgot password, still use client-side Supabase
    if (mode === "forgot") {
      const result = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

      if (result.error) {
        setStatus(`${result.error.message}. You can continue to the product workspace while Supabase is being set up.`);
        setIsSubmitting(false);
        return;
      }

      setStatus("Recovery link sent. Check your inbox for the secure reset email.");
      setIsSubmitting(false);
      return;
    }
  }

  async function handleOAuth(provider: "google" | "azure") {
    if (!supabase) {
      setStatus("Opening the product workspace. Add OAuth providers in Supabase when you are ready for live Google and Microsoft sign-in.");
      window.location.href = "/dashboard";
      return;
    }

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${getSiteUrl()}/auth/callback`,
        queryParams: provider === "google" ? { access_type: "offline", prompt: "consent" } : undefined,
      },
    });

    if (error) {
      setStatus(`${error.message}. Google and Microsoft also need to be enabled inside Supabase Auth providers.`);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="grid min-h-screen lg:grid-cols-[0.95fr_1.05fr]">
        <section className="flex flex-col justify-between bg-navy-950 p-6 text-white navy-grid sm:p-10">
          <Link href="/" className="inline-flex w-fit items-center">
            <Image
              src="/docucorex_transparent_logo.png"
              alt="DocuCoreX"
              width={220}
              height={130}
              priority
              className="h-16 w-auto rounded-2xl bg-white object-contain px-2"
            />
          </Link>
          <div className="my-16 max-w-xl">
            <p className="text-sm font-black uppercase tracking-[0.2em] text-sky-300">Secure document intelligence</p>
            <h1 className="mt-5 text-4xl font-black tracking-normal sm:text-5xl">Sign in to your document command center.</h1>
            <p className="mt-5 text-lg leading-8 text-blue-100">
              Manage uploads, OCR, extraction, conversions, exports and secure document storage from one enterprise-grade workspace.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {profileChecklist.map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.08] p-3 text-sm font-bold text-blue-50">
                  <Check className="h-4 w-4 text-emerald-300" />
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/[0.08] p-5">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-6 w-6 text-sky-300" />
              <div>
                <p className="font-black">Supabase authentication ready</p>
                <p className="text-sm text-blue-100">
                  {isSupabaseConfigured ? "Environment keys detected." : "Add Supabase keys to enable live auth."}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center p-4 sm:p-8">
          <div className="w-full max-w-xl rounded-[2rem] border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
            <div className="mb-6 flex rounded-2xl bg-slate-100 p-1">
              {[
                ["signin", "Login"],
                ["signup", "Create Account"],
                ["forgot", "Forgot Password"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setMode(key as typeof mode)}
                  className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-black transition ${
                    mode === key ? "bg-white text-royal-700 shadow-sm" : "text-slate-500"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div>
              <p className="text-sm font-black uppercase tracking-[0.18em] text-royal-600">
                {mode === "forgot" ? "Account recovery" : "Authentication"}
              </p>
              <h2 className="mt-2 text-3xl font-black text-navy-950">
                {mode === "signin" ? "Welcome back." : mode === "signup" ? "Create your workspace." : "Reset your password."}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                {mode === "forgot"
                  ? "Enter your email and DocuCoreX will send a secure recovery link."
                  : "Use email and password, Google, or Microsoft. Email verification and two-factor controls are built into the account flow."}
              </p>
            </div>

            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => handleOAuth("google")}
                className="flex items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-navy-950 shadow-sm transition hover:border-royal-200 hover:text-royal-700"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-lg font-black text-royal-600">G</span>
                Google Sign-In
              </button>
              <button
                type="button"
                onClick={() => handleOAuth("azure")}
                className="flex items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-navy-950 shadow-sm transition hover:border-royal-200 hover:text-royal-700"
              >
                <span className="grid h-5 w-5 grid-cols-2 gap-0.5">
                  <span className="bg-[#f35325]" />
                  <span className="bg-[#81bc06]" />
                  <span className="bg-[#05a6f0]" />
                  <span className="bg-[#ffba08]" />
                </span>
                Microsoft Sign-In
              </button>
            </div>

            <div className="my-6 flex items-center gap-4">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            <form onSubmit={handleEmailAuth} className="space-y-4">
              <label className="block">
                <span className="mb-2 block text-sm font-black text-slate-700">Email address</span>
                <span className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 focus-within:border-royal-300 focus-within:bg-white">
                  <Mail className="h-5 w-5 text-slate-400" />
                  <input
                    className="w-full bg-transparent text-sm font-semibold outline-none"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    required
                    type="email"
                    value={email}
                  />
                </span>
              </label>

              {mode !== "forgot" ? (
                <label className="block">
                  <span className="mb-2 block text-sm font-black text-slate-700">Password</span>
                  <span className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 focus-within:border-royal-300 focus-within:bg-white">
                    <KeyRound className="h-5 w-5 text-slate-400" />
                    <input
                      className="w-full bg-transparent text-sm font-semibold outline-none"
                      minLength={8}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Enter your password"
                      required
                      type={showPassword ? "text" : "password"}
                      value={password}
                    />
                    <button type="button" onClick={() => setShowPassword((value) => !value)} className="text-slate-400">
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </span>
                </label>
              ) : null}

              {mode !== "forgot" ? (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <label className="flex items-center gap-2 font-bold text-slate-600">
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-royal-600" />
                    Remember this device
                  </label>
                  <button type="button" onClick={() => setMode("forgot")} className="font-black text-royal-700">
                    Forgot password?
                  </button>
                </div>
              ) : null}

              {callbackError ? (
                <div className="flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold leading-6 text-red-800">
                  <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                  <div>{callbackError}</div>
                </div>
              ) : null}

              {status ? (
                <div className="rounded-2xl border border-royal-100 bg-royal-50 p-3 text-sm font-bold leading-6 text-royal-800">
                  {status}
                </div>
              ) : null}

              <button
                disabled={isSubmitting}
                type="submit"
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-royal-600 px-5 py-3.5 text-sm font-black text-white shadow-glow transition hover:-translate-y-0.5 hover:bg-royal-700 disabled:cursor-wait disabled:bg-slate-300"
              >
                {isSubmitting ? "Working…" : mode === "forgot" ? "Send Recovery Link" : mode === "signup" ? "Create Account" : "Login"}
                <ArrowRight className="h-5 w-5" />
              </button>

              {process.env.NODE_ENV !== "production" && (
                <button
                  type="button"
                  onClick={enterDemoWorkspace}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3.5 text-sm font-black text-navy-950 shadow-sm transition hover:border-royal-200 hover:text-royal-700"
                >
                  Continue to Dashboard (Dev Only)
                </button>
              )}
            </form>

            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start gap-3">
                <LockKeyhole className="mt-0.5 h-5 w-5 text-royal-600" />
                <p className="text-sm leading-6 text-slate-600">
                  Two-factor authentication is future-ready in the security model and surfaced in profile settings for rollout.
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50 flex items-center justify-center">Loading...</div>}>
      <LoginContent />
    </Suspense>
  );
}

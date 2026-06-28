"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, XCircle, AlertCircle, Copy, Check } from "lucide-react";
import Link from "next/link";
import { supabase, isSupabaseConfigured, getSiteUrl } from "@/lib/supabase";

interface AuthDiag {
  sessionPresent: boolean;
  userId?: string;
  userEmail?: string;
  profileId?: string;
  workspaceId?: string;
  profileMode?: string;
  sessionError?: string;
  profileError?: string;
  isDemoMode: boolean;
  demoReason?: string;
}

export default function AuthDiagnosticsPage() {
  const [diag, setDiag] = useState<AuthDiag | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function run() {
      try {
        if (!supabase) {
          setDiag({
            sessionPresent: false,
            isDemoMode: process.env.NODE_ENV !== "production",
            demoReason: "Supabase not configured (env vars missing)",
            sessionError: "Supabase client is null",
          });
          setLoading(false);
          return;
        }

        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          setDiag({
            sessionPresent: false,
            isDemoMode: false,
            demoReason: "N/A — Supabase is configured",
            sessionError: sessionError?.message ?? "No active session",
          });
          setLoading(false);
          return;
        }

        // Fetch profile to check demo mode
        const profileRes = await fetch("/api/profile");
        const profileJson = await profileRes.json() as { profile?: { id?: string; workspace_id?: string }; mode?: string; error?: string };

        setDiag({
          sessionPresent: Boolean(session),
          userId: user.id,
          userEmail: user.email,
          profileId: profileJson.profile?.id,
          workspaceId: profileJson.profile?.workspace_id,
          profileMode: profileJson.mode ?? "unknown",
          isDemoMode: profileJson.mode === "demo",
          demoReason: profileJson.mode === "demo" ? "Profile API returned demo mode" : undefined,
          profileError: profileJson.error,
        });
      } catch (err) {
        setDiag({
          sessionPresent: false,
          isDemoMode: false,
          sessionError: err instanceof Error ? err.message : "Unexpected error",
        });
      } finally {
        setLoading(false);
      }
    }
    void run();
  }, []);

  const requireAuth = process.env.NEXT_PUBLIC_REQUIRE_AUTH;
  const nodeEnv = process.env.NODE_ENV;
  const isProduction = nodeEnv === "production";

  const rows: [string, string, boolean?][] = [
    ["NODE_ENV", nodeEnv ?? "undefined", isProduction],
    ["NEXT_PUBLIC_REQUIRE_AUTH", requireAuth ?? "⚠ NOT SET", requireAuth === "true"],
    ["Supabase Configured", isSupabaseConfigured ? "✓ Yes" : "✗ No", isSupabaseConfigured],
    ["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL ?? "⚠ NOT SET", Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)],
    ["NEXT_PUBLIC_SITE_URL", getSiteUrl(), Boolean(getSiteUrl())],
    ["Current URL", typeof window !== "undefined" ? window.location.href : "N/A", true],
    ["Session Present", diag ? (diag.sessionPresent ? "✓ Yes" : "✗ No") : "Loading…", diag?.sessionPresent],
    ["Authenticated User Email", diag?.userEmail ?? (loading ? "Loading…" : "None"), Boolean(diag?.userEmail)],
    ["User ID", diag?.userId ?? (loading ? "Loading…" : "None"), Boolean(diag?.userId)],
    ["Profile ID", diag?.profileId ?? (loading ? "Loading…" : "None"), Boolean(diag?.profileId)],
    ["Workspace ID", diag?.workspaceId ?? (loading ? "Loading…" : "None"), Boolean(diag?.workspaceId)],
    ["Profile Mode", diag?.profileMode ?? (loading ? "Loading…" : "unknown"), diag?.profileMode === "live"],
    ["Demo Mode Active", diag ? (diag.isDemoMode ? "⚠ YES" : "✓ No") : "Loading…", diag ? !diag.isDemoMode : undefined],
    ["Demo Mode Reason", diag?.demoReason ?? "N/A", true],
  ];

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black text-navy-950">Auth Diagnostics</h1>
            <p className="mt-2 text-slate-600">Production debugging for authentication issues</p>
          </div>
          <Link href="/dashboard">
            <button className="flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-300">
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          </Link>
        </div>

        {/* Status Summary */}
        <div className="mb-6 rounded-lg border-2 bg-white p-6">
          {loading ? (
            <div className="flex items-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-royal-600" />
              <p className="font-bold text-slate-600">Checking authentication...</p>
            </div>
          ) : diag?.isDemoMode ? (
            <div className="flex items-start gap-4 border-yellow-200 bg-yellow-50 rounded-lg p-4">
              <AlertCircle className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-black text-yellow-900">⚠ Demo Mode Active</p>
                <p className="text-sm text-yellow-700 mt-1">{diag.demoReason ?? "Profile API returned demo profile"}</p>
              </div>
            </div>
          ) : diag?.sessionPresent ? (
            <div className="flex items-start gap-4 rounded-lg border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle className="h-6 w-6 text-emerald-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-black text-emerald-700">✓ Authenticated — Live Mode</p>
                <p className="text-sm text-emerald-600 mt-1">Real Supabase session active. Demo mode is off.</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4 rounded-lg border-red-200 bg-red-50 p-4">
              <XCircle className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-black text-red-700">✗ Not Authenticated</p>
                <p className="text-sm text-red-600 mt-1">{diag?.sessionError ?? "No session found"}</p>
              </div>
            </div>
          )}
        </div>

        {/* Detail Table */}
        <div className="rounded-lg border-2 border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <h2 className="font-black text-navy-950">Configuration & Session Details</h2>
          </div>
          <div className="divide-y divide-slate-200">
            {rows.map(([key, value, ok]) => (
              <div key={key} className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-slate-50">
                <div className="font-bold text-slate-700 text-sm">{key}</div>
                <div className="flex items-center gap-2">
                  {ok === false && <span className="text-red-500 text-xs font-black">✗</span>}
                  {ok === true && <span className="text-emerald-500 text-xs font-black">✓</span>}
                  <code className="rounded bg-slate-100 px-3 py-1 text-sm font-mono text-slate-900 max-w-xs truncate">
                    {value}
                  </code>
                  <button onClick={() => copyToClipboard(value)} className="rounded p-1 hover:bg-slate-200" title="Copy">
                    {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4 text-slate-400" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Vercel Env Checklist */}
        <div className="mt-6 rounded-lg border-2 border-slate-200 bg-white p-6">
          <h2 className="font-black text-navy-950 mb-4">Vercel Environment Variable Checklist</h2>
          <ul className="space-y-2 text-sm text-slate-700">
            {[
              ["NEXT_PUBLIC_SUPABASE_URL", Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)],
              ["NEXT_PUBLIC_SUPABASE_ANON_KEY", Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)],
              ["SUPABASE_SERVICE_ROLE_KEY", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "")],
              ["NEXT_PUBLIC_SITE_URL = https://www.docucorex.com", getSiteUrl().includes("docucorex.com")],
              ["NEXT_PUBLIC_REQUIRE_AUTH = true", requireAuth === "true"],
            ].map(([label, ok]) => (
              <li key={String(label)} className="flex items-center gap-2">
                <span className={ok ? "text-emerald-600 font-black" : "text-red-600 font-black"}>{ok ? "✓" : "✗"}</span>
                <code className="text-xs">{String(label)}</code>
              </li>
            ))}
          </ul>
        </div>

        {diag?.isDemoMode && (
          <div className="mt-6 rounded-lg border-2 border-red-200 bg-red-50 p-6">
            <div className="flex gap-4">
              <AlertCircle className="h-6 w-6 text-red-700 flex-shrink-0" />
              <div>
                <p className="font-black text-red-900">Demo mode is active — production login is broken</p>
                <ul className="mt-3 space-y-2 text-sm text-red-800">
                  <li>• Go to Vercel → Your Project → Settings → Environment Variables</li>
                  <li>• Ensure all 5 variables above are set correctly</li>
                  <li>• Redeploy after adding missing variables</li>
                  <li>• Check Supabase → Auth → URL Configuration has www.docucorex.com</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


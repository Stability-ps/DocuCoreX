"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, XCircle, AlertCircle, Copy, Check } from "lucide-react";
import Link from "next/link";
import { supabase, isSupabaseConfigured, getSiteUrl } from "@/lib/supabase";

interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  userEmail?: string;
  profileFound?: boolean;
  workspaceFound?: boolean;
  sessionError?: string;
}

export default function AuthDiagnosticsPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function checkAuth() {
      try {
        // Check session
        if (!supabase) {
          setStatus({
            authenticated: false,
            sessionError: "Supabase not configured",
          });
          setLoading(false);
          return;
        }

        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (sessionError) {
          setStatus({
            authenticated: false,
            sessionError: sessionError.message,
          });
          setLoading(false);
          return;
        }

        if (!session?.user) {
          setStatus({
            authenticated: false,
            sessionError: "No active session",
          });
          setLoading(false);
          return;
        }

        // Check user
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setStatus({
            authenticated: false,
            sessionError: "User not found in auth",
          });
          setLoading(false);
          return;
        }

        if (process.env.NODE_ENV === "development") {
          console.log("[Debug Auth] User authenticated:", { userId: user.id, email: user.email });
        }

        setStatus({
          authenticated: true,
          userId: user.id,
          userEmail: user.email,
        });
      } catch (error) {
        setStatus({
          authenticated: false,
          sessionError: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setLoading(false);
      }
    }

    checkAuth();
  }, []);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const diagnosticInfo = {
    "Session Exists": status?.authenticated ? "✓ Yes" : "✗ No",
    "User ID Present": status?.userId ? "✓ Yes" : "✗ No",
    "User Email": status?.userEmail || "N/A",
    "Supabase Configured": isSupabaseConfigured ? "✓ Yes" : "✗ No",
    "Current URL": typeof window !== "undefined" ? window.location.href : "N/A",
    "NEXT_PUBLIC_SITE_URL": getSiteUrl(),
    "Supabase URL": process.env.NEXT_PUBLIC_SUPABASE_URL || "Not set",
    "Node Environment": process.env.NODE_ENV,
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black text-navy-950">Auth Diagnostics</h1>
            <p className="mt-2 text-slate-600">Development debugging for authentication issues</p>
          </div>
          <Link href="/dashboard">
            <button className="flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-300">
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          </Link>
        </div>

        {/* Status Summary */}
        <div className="mb-6 rounded-lg border-2 border-slate-200 bg-white p-6">
          {loading ? (
            <div className="flex items-center justify-center gap-3">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-royal-600" />
              <p className="font-bold text-slate-600">Checking authentication...</p>
            </div>
          ) : status?.authenticated ? (
            <div className="flex items-start gap-4">
              <CheckCircle className="h-6 w-6 text-emerald-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-black text-emerald-700">✓ Authenticated</p>
                <p className="text-sm text-emerald-600 mt-1">User session is active and valid</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <XCircle className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-black text-red-700">✗ Not Authenticated</p>
                <p className="text-sm text-red-600 mt-1">{status?.sessionError || "Unknown error"}</p>
              </div>
            </div>
          )}
        </div>

        {/* Diagnostic Details */}
        <div className="rounded-lg border-2 border-slate-200 bg-white overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <h2 className="font-black text-navy-950">Configuration & Status</h2>
          </div>
          <div className="divide-y divide-slate-200">
            {Object.entries(diagnosticInfo).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-slate-50">
                <div className="font-bold text-slate-700">{key}</div>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-slate-100 px-3 py-1 text-sm font-mono text-slate-900 max-w-xs truncate">
                    {value}
                  </code>
                  <button
                    onClick={() => copyToClipboard(String(value))}
                    className="rounded p-1 hover:bg-slate-200"
                    title="Copy to clipboard"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <Copy className="h-4 w-4 text-slate-400" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Help Section */}
        {!status?.authenticated && (
          <div className="mt-6 rounded-lg border-2 border-yellow-200 bg-yellow-50 p-6">
            <div className="flex gap-4">
              <AlertCircle className="h-6 w-6 text-yellow-700 flex-shrink-0" />
              <div>
                <p className="font-black text-yellow-900">Troubleshooting Tips</p>
                <ul className="mt-3 space-y-2 text-sm text-yellow-800">
                  <li>• Verify Supabase credentials in environment variables</li>
                  <li>• Check NEXT_PUBLIC_SITE_URL matches your domain</li>
                  <li>• Ensure cookies are enabled in your browser</li>
                  <li>• Check browser console (F12) for JavaScript errors</li>
                  <li>• Verify authentication workflow completed at /auth/callback</li>
                  <li>• Check Supabase dashboard for user creation</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Development Notice */}
        {process.env.NODE_ENV === "development" && (
          <div className="mt-6 rounded-lg border border-slate-300 bg-slate-100 p-4 text-xs text-slate-700">
            <p className="font-bold">ℹ Development Mode</p>
            <p className="mt-1">Detailed logging is enabled in the console. Check browser DevTools for additional debug information.</p>
          </div>
        )}
      </div>
    </div>
  );
}

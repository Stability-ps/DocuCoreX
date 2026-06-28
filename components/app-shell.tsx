"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, Command, LogOut, Search, ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/brand";
import { appNav } from "@/lib/product-data";
import type { NotificationRecord } from "@/lib/app-state";

type ProfileState = { fullName?: string; company?: string; role?: string } | null;
type SearchResult = { id: string; name: string; type: string; detail: string };

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [profile, setProfile] = useState<ProfileState>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    async function loadShellData() {
      const [profileResponse, notificationsResponse] = await Promise.all([
        fetch("/api/profile"),
        fetch("/api/notifications"),
      ]);

      if (profileResponse.ok) {
        const data = (await profileResponse.json()) as { profile?: ProfileState };
        setProfile(data.profile ?? null);
      }

      if (notificationsResponse.ok) {
        const data = (await notificationsResponse.json()) as { notifications?: NotificationRecord[] };
        setNotifications(data.notifications ?? []);
      }
    }

    void loadShellData();
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      if (!query.trim()) {
        setSearchResults([]);
        return;
      }
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) return;
      const data = (await response.json()) as { results?: SearchResult[] };
      setSearchResults(data.results ?? []);
    }, 180);

    return () => window.clearTimeout(handle);
  }, [query]);

  async function markNotificationsRead() {
    const response = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allRead: true }),
    });
    if (response.ok) {
      const data = (await response.json()) as { notifications: NotificationRecord[] };
      setNotifications(data.notifications);
    }
  }

  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return (
    <div className="min-h-screen bg-slate-50 text-navy-950">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 border-r border-slate-200 bg-white lg:block">
        <div className="flex h-20 items-center border-b border-slate-100 px-5">
          <BrandLogo compact />
        </div>
        <nav className="space-y-1 px-4 py-5">
          {appNav.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-black transition ${
                  active ? "bg-royal-600 text-white shadow-glow" : "text-slate-600 hover:bg-royal-50 hover:text-royal-700"
                }`}
              >
                <item.icon className="h-5 w-5" />
                {item.title}
              </Link>
            );
          })}
        </nav>
        <div className="absolute inset-x-4 bottom-4 rounded-3xl bg-navy-950 p-4 text-white navy-grid">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-white/10 p-2">
              <ShieldCheck className="h-5 w-5 text-sky-300" />
            </div>
            <div>
              <p className="text-sm font-black">Enterprise vault</p>
              <p className="text-xs text-blue-100">Encrypted storage ready</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/88 backdrop-blur-xl">
          <div className="flex h-20 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="lg:hidden">
              <BrandLogo compact />
            </div>
            <div className="relative hidden w-full max-w-xl lg:block">
              <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  className="w-full bg-transparent text-sm font-semibold outline-none placeholder:text-slate-400"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search documents, folders, tags or extracted text"
                  value={query}
                />
                <Command className="h-4 w-4 text-slate-400" />
              </div>
              {searchResults.length ? (
                <div className="absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-soft">
                  {searchResults.map((document) => (
                    <Link
                      key={document.id}
                      href={`/documents/${document.id}`}
                      onClick={() => setQuery("")}
                      className="block border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-royal-50"
                    >
                      <p className="font-black text-navy-950">{document.name}</p>
                      <p className="text-sm text-slate-500">{document.detail || document.type}</p>
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNotifications((value) => !value)}
                className="relative rounded-2xl border border-slate-200 bg-white p-3 text-slate-600 shadow-sm transition hover:text-royal-700"
                title="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unreadCount ? <span className="absolute -right-1 -top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-black text-white">{unreadCount}</span> : null}
              </button>
              <Link href="/auth/signout" className="rounded-2xl border border-slate-200 bg-white p-3 text-slate-600 shadow-sm transition hover:text-royal-700" title="Sign out">
                <LogOut className="h-5 w-5" />
              </Link>
              <button
                onClick={() => setShowProfile((value) => !value)}
                className="flex h-11 min-w-11 items-center justify-center rounded-2xl bg-navy-950 px-2 text-sm font-black text-white"
                title="Account menu"
              >
                {profile?.fullName?.charAt(0) ?? "?"}
              </button>
            </div>
          </div>
          {showNotifications ? (
            <div className="absolute right-20 top-20 z-50 w-[min(420px,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-4 shadow-soft">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-black text-navy-950">Notifications</p>
                <button onClick={markNotificationsRead} className="text-xs font-black text-royal-700">Mark all read</button>
              </div>
              <div className="space-y-2">
                {notifications.map((notification) => (
                  <div key={notification.id} className={`rounded-2xl p-3 ${notification.read ? "bg-slate-50" : "bg-royal-50"}`}>
                    <p className="font-black text-navy-950">{notification.title}</p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{notification.body}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {showProfile ? (
            <div className="absolute right-6 top-20 z-50 w-64 rounded-3xl border border-slate-200 bg-white p-4 shadow-soft">
              <p className="font-black text-navy-950">{profile?.fullName ?? "Account"}</p>
              <p className="text-sm text-slate-500">{profile?.company ?? ""}</p>
              <div className="mt-4 grid gap-2">
                <Link href="/settings" className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-black text-slate-700 hover:text-royal-700">Account settings</Link>
                <Link href="/team" className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-black text-slate-700 hover:text-royal-700">Team access</Link>
                <Link href="/auth/signout" className="rounded-2xl bg-rose-50 px-3 py-2 text-sm font-black text-rose-700">Sign out</Link>
              </div>
            </div>
          ) : null}
          <nav className="flex gap-2 overflow-x-auto border-t border-slate-100 px-4 py-3 lg:hidden">
            {appNav.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs font-black ${
                    active ? "bg-royal-600 text-white" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.title}
                </Link>
              );
            })}
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}

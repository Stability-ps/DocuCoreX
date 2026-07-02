"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, ChevronDown, Command, CreditCard, Folder, Home, Landmark, LogOut, Plus, Search, Settings, ShieldCheck, Upload, UsersRound } from "lucide-react";
import { BrandLogo } from "@/components/brand";
import { appNav, newActionItems } from "@/lib/product-data";
import type { NotificationRecord } from "@/lib/app-state";

type ProfileState = { fullName?: string; full_name?: string; email?: string; company?: string; role?: string } | null;
type SearchResult = { id: string; name: string; type: string; detail: string };

const SHELL_PROFILE_CACHE_KEY = "docucorex:shell:profile";
const SHELL_NOTIFICATIONS_CACHE_KEY = "docucorex:shell:notifications";
const SHELL_CACHE_TTL_MS = 60_000;
const mobileTabs = [
  { title: "Home", href: "/dashboard", icon: Home },
  { title: "Documents", href: "/documents", icon: Folder },
  { title: "Upload", href: "/upload", icon: Upload },
  { title: "Accounting", href: "/accounting", icon: Landmark },
  { title: "Settings", href: "/settings", icon: Settings },
];

function profileName(profile: ProfileState) {
  if (!profile) return "";
  return profile.fullName?.trim() || profile.full_name?.trim() || "";
}

function profileInitials(profile: ProfileState) {
  const candidates = [
    profileName(profile),
    profile?.email?.split("@")[0] ?? "",
    profile?.company ?? "",
    "DocuCoreX User",
  ];

  for (const value of candidates) {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (!parts.length) continue;
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0].slice(0, 1)}${parts[1].slice(0, 1)}`.toUpperCase();
  }

  return "DU";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileState>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showMobileNav, setShowMobileNav] = useState(true);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    Documents: false,
    "Convert Files": false,
  });
  const [shellError, setShellError] = useState("");
  const searchCacheRef = useRef<Map<string, SearchResult[]>>(new Map());

  useEffect(() => {
    const cachedProfile = readCached<ProfileState>(SHELL_PROFILE_CACHE_KEY, SHELL_CACHE_TTL_MS);
    const cachedNotifications = readCached<NotificationRecord[]>(SHELL_NOTIFICATIONS_CACHE_KEY, SHELL_CACHE_TTL_MS);

    if (cachedProfile !== null) {
      setProfile(cachedProfile);
    }

    if (cachedNotifications) {
      setNotifications(cachedNotifications);
    }

    const controller = new AbortController();

    async function loadShellData() {
      const [profileResult, notificationsResult] = await Promise.allSettled([
        fetch("/api/profile", { signal: controller.signal }),
        fetch("/api/notifications", { signal: controller.signal }),
      ]);

      if (profileResult.status === "fulfilled") {
        const profileResponse = profileResult.value;

        if (profileResponse.ok) {
          const data = (await profileResponse.json()) as { profile?: ProfileState };
          const resolvedProfile = data.profile ?? null;
          setProfile(resolvedProfile);
          writeCached(SHELL_PROFILE_CACHE_KEY, resolvedProfile);
          setShellError("");
        } else if (profileResponse.status === 401) {
          setProfile(null);
          setShellError("");
        } else {
          const data = (await profileResponse.json().catch(() => ({}))) as { error?: string };
          setShellError(data.error ?? "Workspace profile could not be loaded. Refresh the page or open diagnostics if this continues.");
        }
      }

      if (notificationsResult.status === "fulfilled") {
        const notificationsResponse = notificationsResult.value;

        if (notificationsResponse.ok) {
          const data = (await notificationsResponse.json()) as { notifications?: NotificationRecord[] };
          const resolvedNotifications = data.notifications ?? [];
          setNotifications(resolvedNotifications);
          writeCached(SHELL_NOTIFICATIONS_CACHE_KEY, resolvedNotifications);
        }
      }
    }

    void loadShellData();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const normalized = query.trim().toLowerCase();

    if (!normalized) {
      setSearchResults([]);
      return;
    }

    const cached = searchCacheRef.current.get(normalized);
    if (cached) {
      setSearchResults(cached);
    }

    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      const response = await fetch(`/api/search?q=${encodeURIComponent(normalized)}`, { signal: controller.signal });
      if (!response.ok) return;
      const data = (await response.json()) as { results?: SearchResult[] };
      const results = data.results ?? [];
      searchCacheRef.current.set(normalized, results);
      setSearchResults(results);
    }, 120);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    for (const tab of mobileTabs) {
      router.prefetch(tab.href);
    }

    for (const item of appNav) {
      router.prefetch(item.href);
      if (item.children?.length) {
        for (const child of item.children) {
          router.prefetch(child.href);
        }
      }
    }
  }, [router]);

  useEffect(() => {
    let lastY = window.scrollY;
    const handleScroll = () => {
      const currentY = window.scrollY;
      if (currentY <= 8) {
        setShowMobileNav(true);
        lastY = currentY;
        return;
      }
      if (currentY > lastY + 6) setShowMobileNav(false);
      if (currentY < lastY - 6) setShowMobileNav(true);
      lastY = currentY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

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

  function signOut() {
    window.location.assign("/auth/signout");
  }

  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  const isExactActive = (href: string) => pathname === href;
  const currentPageTitle =
    mobileTabs.find((item) => isActive(item.href))?.title ??
    appNav.find((item) => isActive(item.href) || item.children?.some((child) => isActive(child.href)))?.title ??
    "DocuCoreX";

  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-50 text-navy-950">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 border-r border-slate-200 bg-white lg:block">
        <div className="flex h-20 items-center border-b border-slate-100 px-5">
          <BrandLogo compact />
        </div>
        <div className="relative px-4 pt-4">
          <button
            type="button"
            onClick={() => setShowNewMenu((value) => !value)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy-950 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-royal-700"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
          {showNewMenu ? (
            <div className="absolute left-4 right-4 top-16 z-50 overflow-hidden rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
              {newActionItems.map((item) => (
                <Link
                  key={item.title}
                  href={item.href}
                  onClick={() => setShowNewMenu(false)}
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-royal-50 hover:text-royal-700"
                >
                  <item.icon className="h-4 w-4 text-slate-400" />
                  {item.title}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <nav className="space-y-1 px-4 py-5">
          {appNav.map((item) => {
            const active = isActive(item.href) || Boolean(item.children?.some((child) => isActive(child.href)));
            const expanded = expandedGroups[item.title] ?? false;

            if (item.children?.length) {
              return (
                <div key={item.href} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setExpandedGroups((current) => ({ ...current, [item.title]: !(current[item.title] ?? active) }))}
                    className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm font-semibold transition ${
                      active ? "bg-royal-50 text-royal-800" : "text-slate-600 hover:bg-slate-50 hover:text-navy-950"
                    }`}
                  >
                    <item.icon className="h-5 w-5" />
                    <span className="min-w-0 flex-1 text-left">{item.title}</span>
                    <ChevronDown className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  {expanded ? (
                    <div className="ml-5 space-y-1 border-l border-slate-100 pl-3">
                      {item.children.map((child) => {
                        const childActive = isExactActive(child.href);
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-bold transition ${
                              childActive ? "bg-royal-600 text-white shadow-sm" : "text-slate-500 hover:bg-royal-50 hover:text-royal-700"
                            }`}
                          >
                            <child.icon className="h-4 w-4" />
                            {child.title}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-semibold transition ${
                  active ? "bg-royal-600 text-white shadow-sm" : "text-slate-600 hover:bg-royal-50 hover:text-royal-700"
                }`}
              >
                <item.icon className="h-5 w-5" />
                {item.title}
              </Link>
            );
          })}
        </nav>
        <div className="absolute inset-x-4 bottom-4 rounded-xl bg-navy-950 p-4 text-white navy-grid">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-white/10 p-2">
              <ShieldCheck className="h-5 w-5 text-sky-300" />
            </div>
            <div>
              <p className="text-sm font-semibold">Enterprise vault</p>
              <p className="text-xs text-blue-100">Encrypted storage ready</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/88 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
          {shellError ? (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-900 sm:px-6 lg:px-8">
              {shellError}{" "}
              <Link href="/debug/auth" className="underline">
                Check auth status
              </Link>
            </div>
          ) : null}
          <div className="flex h-16 items-center justify-between gap-3 px-4 lg:hidden">
            <div className="flex min-w-0 items-center gap-3">
              <BrandLogo compact />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-navy-950">{currentPageTitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNotifications((value) => !value)}
                className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm"
                title="Notifications"
                aria-label="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unreadCount ? <span className="absolute -right-1 -top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">{unreadCount}</span> : null}
              </button>
              <button
                onClick={() => setShowProfile((value) => !value)}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-navy-950 text-sm font-semibold text-white"
                title="Account menu"
                aria-label="Account menu"
              >
                {profileInitials(profile)}
              </button>
            </div>
          </div>
          <div className="hidden h-20 items-center justify-between gap-4 px-4 sm:px-6 lg:flex lg:px-8">
            <div className="relative hidden w-full max-w-xl lg:block">
              <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-slate-50 px-4 py-2.5">
                <Search className="h-4 w-4 text-slate-400" />
                <input
                  className="w-full bg-transparent text-sm font-semibold outline-none placeholder:text-slate-400"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search documents, tags or extracted text"
                  value={query}
                />
                <Command className="h-4 w-4 text-slate-400" />
              </div>
              {searchResults.length ? (
                <div className="absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-soft">
                  {searchResults.map((document) => (
                    <Link
                      key={document.id}
                      href={`/documents/${document.id}`}
                      onClick={() => setQuery("")}
                      className="block border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-royal-50"
                    >
                      <p className="font-semibold text-navy-950">{document.name}</p>
                      <p className="text-sm text-slate-500">{document.detail || document.type}</p>
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNotifications((value) => !value)}
                className="relative rounded-lg border border-slate-200 bg-white p-3 text-slate-600 shadow-sm transition hover:text-royal-700"
                title="Notifications"
              >
                <Bell className="h-5 w-5" />
                {unreadCount ? <span className="absolute -right-1 -top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">{unreadCount}</span> : null}
              </button>
              <button
                type="button"
                onClick={signOut}
                className="rounded-lg border border-slate-200 bg-white p-3 text-slate-600 shadow-sm transition hover:text-royal-700"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="h-5 w-5" />
              </button>
              <button
                onClick={() => setShowProfile((value) => !value)}
                className="flex h-11 min-w-11 items-center justify-center rounded-lg bg-navy-950 px-2 text-sm font-semibold text-white"
                title="Account menu"
              >
                {profileInitials(profile)}
              </button>
            </div>
          </div>
          {showNotifications ? (
            <div className="absolute right-4 top-16 z-50 w-[min(420px,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-4 shadow-soft lg:right-20 lg:top-20">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold text-navy-950">Notifications</p>
                <button onClick={markNotificationsRead} className="text-xs font-semibold text-royal-700">Mark all read</button>
              </div>
              <div className="space-y-2">
                {notifications.map((notification) => (
                  <div key={notification.id} className={`rounded-lg p-3 ${notification.read ? "bg-slate-50" : "bg-royal-50"}`}>
                    <p className="font-semibold text-navy-950">{notification.title}</p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">{notification.body}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {showProfile ? (
            <div className="absolute right-4 top-16 z-50 w-72 rounded-xl border border-slate-200 bg-white p-4 shadow-soft lg:right-6 lg:top-20">
              <p className="font-semibold text-navy-950">{profileName(profile) || "Account"}</p>
              <p className="text-sm text-slate-500">{profile?.company ?? ""}</p>
              <div className="mt-4 grid gap-2">
                <Link href="/settings" onClick={() => setShowProfile(false)} className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:text-royal-700">Profile</Link>
                <Link href="/billing" onClick={() => setShowProfile(false)} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:text-royal-700"><CreditCard className="h-4 w-4" /> Billing & Subscription</Link>
                <Link href="/team" onClick={() => setShowProfile(false)} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 hover:text-royal-700"><UsersRound className="h-4 w-4" /> Team</Link>
                <button
                  type="button"
                  onClick={signOut}
                  className="rounded-lg bg-rose-50 px-3 py-2 text-left text-sm font-semibold text-rose-700"
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : null}
        </header>
        <main className="pb-[calc(5.75rem+env(safe-area-inset-bottom)+8px)] lg:pb-0">{children}</main>
        <nav
          className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur-xl transition-transform duration-200 lg:hidden ${
            showMobileNav ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <div className="grid grid-cols-5 gap-1">
            {mobileTabs.map((item) => {
              const active = isActive(item.href);
              const uploadTab = item.href === "/upload";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-semibold transition ${
                    active
                      ? "bg-royal-600 text-white shadow-sm scale-[1.02]"
                      : uploadTab
                        ? "bg-royal-50 text-royal-700 ring-1 ring-royal-200"
                        : "text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  {item.title}
                  {item.href === "/dashboard" && unreadCount > 0 ? (
                    <span className="absolute right-2 top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold text-white">
                      {unreadCount}
                    </span>
                  ) : null}
                  {active ? <span className="absolute -bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" /> : null}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}

function readCached<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; at: number };
    if (Date.now() - parsed.at > ttlMs) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    return null;
  }
}

function writeCached<T>(key: string, value: T) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // Ignore cache write failures.
  }
}

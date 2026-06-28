import type { CookieOptions } from "@supabase/ssr";
import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";

type CookieLike = {
  name: string;
  value: string;
};

type CookieSetter = {
  set: (name: string, value: string, options?: Partial<ResponseCookie>) => unknown;
};

export function dedupeCookies<T extends CookieLike>(cookies: T[]) {
  const byName = new Map<string, T>();
  cookies.forEach((cookie) => {
    byName.set(cookie.name, cookie);
  });
  return Array.from(byName.values());
}

export function setSupabaseAuthCookie(
  cookieStore: CookieSetter,
  cookie: { name: string; value: string; options: CookieOptions },
  httpOnly = false,
) {
  clearLegacySupabaseCookie(cookieStore, cookie.name);
  cookieStore.set(cookie.name, cookie.value, {
    ...cookie.options,
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function clearLegacySupabaseCookie(cookieStore: CookieSetter, name: string) {
  const expired = {
    path: "/",
    maxAge: 0,
    expires: new Date(0),
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };

  cookieStore.set(name, "", expired);
  cookieStore.set(name, "", { ...expired, domain: "docucorex.com" });
  cookieStore.set(name, "", { ...expired, domain: ".docucorex.com" });
  cookieStore.set(name, "", { ...expired, domain: "www.docucorex.com" });
}

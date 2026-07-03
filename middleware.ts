import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { dedupeCookies } from "@/lib/auth-cookies";

const publicPrefixes = ["/", "/login", "/signup", "/auth/callback", "/auth/signout", "/debug/auth"];

const protectedPrefixes = [
  "/dashboard",
  "/intake",
  "/upload",
  "/documents",
  "/convert",
  "/accounting",
  "/invoices",
  "/billing",
  "/integrations",
  "/automations",
  "/team",
  "/help",
  "/settings",
];

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const host = request.headers.get("host") ?? "";

  if (host === "docucorex.com") {
    const canonicalUrl = request.nextUrl.clone();
    canonicalUrl.protocol = "https";
    canonicalUrl.host = "www.docucorex.com";
    return NextResponse.redirect(canonicalUrl, 308);
  }

  if (pathname.startsWith("/_next") || pathname.startsWith("/api") || pathname.includes(".")) {
    return NextResponse.next();
  }

  const isExplicitPublic = publicPrefixes.some((prefix) => (prefix === "/" ? pathname === "/" : pathname.startsWith(prefix)));
  const isProtected = protectedPrefixes.some((prefix) => pathname.startsWith(prefix));

  if (isExplicitPublic || !isProtected) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const authRequired = process.env.NODE_ENV === "production" ? process.env.NEXT_PUBLIC_REQUIRE_AUTH !== "false" : process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true";

  if (!authRequired || !supabaseUrl || !supabaseAnonKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return dedupeCookies(request.cookies.getAll());
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // If getUser fails (e.g. Supabase network hiccup), fall back to reading
  // the local session from the cookie without a network call.
  if (error && !user) {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session?.user) {
      return response;
    }
    // No valid session at all — redirect to login without session_expired
    // (it's just a missing session, not an actual expiry error)
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/intake/:path*",
    "/upload/:path*",
    "/documents/:path*",
    "/convert/:path*",
    "/accounting/:path*",
    "/invoices/:path*",
    "/billing/:path*",
    "/integrations/:path*",
    "/automations/:path*",
    "/team/:path*",
    "/help/:path*",
    "/settings/:path*",
    "/debug/:path*",
  ],
};

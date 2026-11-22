import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/security-policy";

// Where core listens, which only this server reaches: the browser calls /core on this origin, so
// the owner's session cookie stays the web app's own. Read as this server starts, never as the
// app is built, so one build serves core on whichever port it listens. Unset, core on this machine.
const CORE_URL = (process.env.CORE_URL?.trim() || "http://127.0.0.1:4000").replace(/\/+$/u, "");

/** Passes /core on to core, and adds a fresh CSP nonce to every Auni HTML entry document. */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/core/"))
    return NextResponse.rewrite(`${CORE_URL}${pathname.slice("/core".length)}${search}`);

  const nonce = Buffer.from(crypto.randomUUID(), "utf8").toString("base64");
  const policy = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  matcher: [
    "/core/:path*",
    {
      source:
        "/((?!core(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|.*\\.(?:avif|css|gif|ico|jpe?g|js|json|map|mp4|pdf|png|svg|txt|webmanifest|webp|woff2?|xml)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

const SAFE_NONCE = /^[A-Za-z0-9+/_=-]{16,128}$/u;

/** Builds the nonce-bearing policy used on every Auni HTML entry document. */
export function buildContentSecurityPolicy(nonce: string, development: boolean): string {
  if (!SAFE_NONCE.test(nonce)) throw new TypeError("Content security nonce is invalid");

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    // Core is reached on this origin, through the /core rewrite, live stream and all.
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** The nonce a policy built here allows, for a script the page writes inline itself. */
export function nonceOf(policy: string | null): string | undefined {
  return /'nonce-([^']+)'/u.exec(policy ?? "")?.[1];
}

/** The headers every response carries. */
export const BROWSER_SECURITY_HEADERS: readonly { readonly key: string; readonly value: string }[] =
  [
    // Counts only where Auni is reached over https (hosts/): a browser ignores it over http.
    { key: "Strict-Transport-Security", value: "max-age=63072000" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), clipboard-write=(self)",
    },
  ];

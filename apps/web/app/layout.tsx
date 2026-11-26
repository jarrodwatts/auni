import "./globals.css";

import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { WEAR_LOOK_FIRST } from "@/lib/look-first";
import { nonceOf } from "@/lib/security-policy";
import { TITLE_TEMPLATE } from "@/lib/site";

import { FONT_VARIABLES } from "./fonts";

// A person's own Auni: nothing in it is for search engines.
export const metadata: Metadata = {
  applicationName: "auni",
  title: { default: "auni", template: TITLE_TEMPLATE },
  robots: { index: false, follow: false },
  formatDetection: {
    address: false,
    email: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  // The page's colour in the light look (--background), which Auni wears unless the owner picks
  // another (lib/look.tsx tells the bar then): the browser's own bar reads no stylesheet.
  themeColor: "#ffffff",
  // Lets env(safe-area-inset-*) report the notch and home indicator; each edge pads for itself.
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The request-scoped CSP nonce can only be attached to dynamically rendered documents, and
  // reading it makes this one.
  const nonce = nonceOf((await headers()).get("content-security-policy"));

  return (
    // The script below may name a look on this element before React reads it.
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: WEAR_LOOK_FIRST }} />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}

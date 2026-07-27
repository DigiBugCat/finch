import {ClerkProvider} from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

// Clerk components themed to the Finch palette (globals.css / dashboard.css
// tokens — warm dark bg, amber accent, Nunito). Values are duplicated here
// because Clerk renders some surfaces (modals, portals) outside our CSS scope.
const clerkAppearance = {
  variables: {
    colorBackground: "#2d271c", // --card
    colorInput: "#1c1711", // --input-bg
    colorForeground: "#f1e9d8", // --ink
    colorMutedForeground: "#a89d85", // --dim
    colorInputForeground: "#f1e9d8",
    colorPrimary: "#f2b443", // --amber
    colorPrimaryForeground: "#2a200c", // matches .btn-amber ink
    colorBorder: "#3f3725",
    colorDanger: "#e8848f", // --red
    colorSuccess: "#79d995", // --green
    colorNeutral: "#f1e9d8",
    borderRadius: "12px",
    fontFamily: '"Nunito", system-ui, sans-serif',
  },
  elements: {
    card: { border: "1px solid #3f3725", boxShadow: "0 20px 60px -20px rgba(0,0,0,.6)" },
    formButtonPrimary: { fontWeight: 800, textTransform: "none" as const },
    socialButtonsBlockButton: { border: "1px solid #3f3725" },
    footerActionLink: { color: "#f2b443", fontWeight: 700 },
  },
};

export const metadata: Metadata = {
  title: "Finch — your AI, meet the real world",
  description:
    "Finch turns any spare computer — a Mac mini, a Raspberry Pi, that laptop in the closet — into a safe, always-on helper your AI can actually use. No servers. No wiring. No open ports.",
};

/**
 * Pin Clerk's post-auth redirect allowlist on the production instance.
 *
 * Left unset, Clerk derives the allowlist from the frontend API and permits the
 * wildcard `https://*.<eTLD+1>`. On production that is `https://*.finchmcp.com`
 * — and every one of those subdomains is a tenant's own slug host, which serves
 * arbitrary tenant HTML once a service is set to auth "public". So a link on the
 * genuine sign-in page (`?redirect_url=https://evil.finchmcp.com/...`) would
 * land an authenticated user on attacker content under the real domain: a clean
 * phishing pretext, and a delivery page for a framing attack.
 *
 * Only the production (pk_live) instance is affected — a pk_test instance's
 * frontend API is on accounts.dev, so its wildcard cannot cover a tenant host.
 * Returning undefined elsewhere keeps Clerk's default, which includes the
 * current origin and so keeps local dev and the workers.dev previews working.
 *
 * Safe to narrow: middleware only ever sets redirect_url to request.url (always
 * this origin), and the portal login-wall hop to a tenant host does not use
 * Clerk's redirect machinery — app/portal/start/route.ts issues its own
 * Response.redirect after auth().
 */
function allowedRedirectOrigins(): string[] | undefined {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  return key.startsWith("pk_live_") ? ["https://finchmcp.com"] : undefined;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Nunito, loaded exactly as the design handoff does, so the verbatim
            `font-family:"Nunito"` in globals.css resolves correctly. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ClerkProvider
          appearance={clerkAppearance}
          allowedRedirectOrigins={allowedRedirectOrigins()}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
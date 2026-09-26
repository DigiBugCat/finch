import {ClerkProvider} from "@clerk/nextjs";
import type { Metadata } from "next";
import { IBM_Plex_Mono, Kalam, Manrope, Newsreader } from "next/font/google";
import PaintDefs from "@/components/fieldguide/PaintDefs";
import "./globals.css";

// Indigo Wash type, self-hosted by next/font (downloaded at build time and
// served from this origin, so the CSP needs no font or stylesheet host). Each
// exposes a CSS variable that globals.css folds into --serif/--sans/--hand/
// --mono with the design system's fallbacks; next/font's metric-matched
// fallback faces keep the swap from shifting layout.
const newsreader = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-newsreader",
});
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});
const kalam = Kalam({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-kalam",
  preload: false,
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
  preload: false,
});

const SANS = 'var(--font-manrope), Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// Clerk's <SignIn>/<SignUp>/<UserButton> in Indigo Wash Paper. Colours are the
// token hex values rather than var(--…) because Clerk derives tints and alpha
// scales from them and renders some surfaces (popovers, modals) in portals.
const clerkAppearance = {
  variables: {
    colorBackground: "#f9f5ec", // surface-raised
    colorInput: "#f1ebdd", // surface
    colorInputForeground: "#1f2a44", // ink
    colorForeground: "#1f2a44", // ink
    colorMutedForeground: "#5a5f6e", // ink-muted
    colorMuted: "#f1ebdd", // surface
    colorPrimary: "#23456b", // indigo
    colorPrimaryForeground: "#f9f5ec", // on-indigo
    colorDanger: "#b4462f", // vermilion
    colorSuccess: "#3e6b4f", // leaf
    colorWarning: "#e0a84a", // ochre
    colorNeutral: "#1f2a44", // ink
    colorBorder: "#cfc3ab", // line
    colorRing: "#b4462f", // focus
    colorShadow: "#1f2a44",
    colorModalBackdrop: "rgba(31,42,68,0.35)",
    borderRadius: "6px", // radius-md
    fontFamily: SANS,
    fontFamilyButtons: SANS,
    fontFamilyMono: 'var(--font-plex-mono), "IBM Plex Mono", ui-monospace, Menlo, monospace',
  },
  elements: {
    card: { boxShadow: "1px 2px 0 rgba(31,42,68,.07), 2px 4px 8px rgba(31,42,68,.14)" },
    headerTitle: {
      fontFamily: 'var(--font-newsreader), Newsreader, "Iowan Old Style", Georgia, serif',
      fontWeight: 500,
      fontSize: "1.75rem",
      letterSpacing: "-0.01em",
    },
    formButtonPrimary: { fontWeight: 600, textTransform: "none" as const },
    formFieldInput: { borderColor: "#23456b" },
    footerActionLink: { color: "#23456b", fontWeight: 700 },
  },
};

const TITLE = "finch — localhost, with a front door";
const DESCRIPTION =
  "finch gives the MCP server on your Mac or Linux machine a stable https address, with keys or OAuth at the door. Your machine calls out to finch, so nothing on it is left open. Free.";

export const metadata: Metadata = {
  metadataBase: new URL("https://finchmcp.com"),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://finchmcp.com",
    siteName: "finch",
    type: "website",
  },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
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
 * Safe to narrow: nothing in this app sends a signed-in user to another origin
 * — sign-in only ever returns to pages on this one (the /cli approval page, the
 * docs).
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
    <html
      lang="en"
      className={`${newsreader.variable} ${manrope.variable} ${kalam.variable} ${plexMono.variable}`}
    >
      <body>
        <PaintDefs />
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

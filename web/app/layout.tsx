import {ClerkProvider} from "@clerk/nextjs";
import type { Metadata } from "next";
import "./globals.css";

// Clerk components themed to the Finch palette (globals.css / dashboard.css
// tokens — warm dark bg, amber accent, Nunito). Values are duplicated here
// because Clerk renders some surfaces (modals, portals) outside our CSS scope.
const clerkAppearance = {
  variables: {
    colorBackground: "#2d271c", // --card
    colorInputBackground: "#1c1711", // --input-bg
    colorText: "#f1e9d8", // --ink
    colorTextSecondary: "#a89d85", // --dim
    colorInputText: "#f1e9d8",
    colorPrimary: "#f2b443", // --amber
    colorTextOnPrimaryBackground: "#2a200c", // matches .btn-amber ink
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
        <ClerkProvider appearance={clerkAppearance}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
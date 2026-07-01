import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
      {/* fallbackRedirectUrl guarantees the dashboard landing regardless of how
          the NEXT_PUBLIC_CLERK_* env var is (or isn't) inlined by the build; a
          real redirect_url (e.g. returning to /cli or a gated appliance) still
          wins over the fallback. */}
      <SignIn fallbackRedirectUrl="/dashboard" />
    </div>
  );
}

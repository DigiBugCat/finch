import { SignIn } from "@clerk/nextjs";
import AuthShell from "@/components/fieldguide/AuthShell";

export default function SignInPage() {
  return (
    <AuthShell note="sign in once, in your browser">
      {/* fallbackRedirectUrl sends a plain sign-in to the signed-in fleet page
          regardless of how the NEXT_PUBLIC_CLERK_* env var is (or isn't)
          inlined by the build; a real redirect_url (e.g. returning to a /cli
          approval link) still wins over the fallback. */}
      <SignIn fallbackRedirectUrl="/fleet" />
    </AuthShell>
  );
}

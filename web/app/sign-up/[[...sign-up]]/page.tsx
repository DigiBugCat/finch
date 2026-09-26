import { SignUp } from "@clerk/nextjs";
import AuthShell from "@/components/fieldguide/AuthShell";

export default function SignUpPage() {
  return (
    <AuthShell note="free, and the band is yours for life">
      <SignUp fallbackRedirectUrl="/docs" />
    </AuthShell>
  );
}

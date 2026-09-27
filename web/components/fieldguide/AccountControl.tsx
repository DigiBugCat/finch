"use client";
// The nav's account slot: Clerk's UserButton (sign out, switch account) for a
// signed-in visitor, a "Sign in" link otherwise. The landing and /docs are
// prerendered, so the server HTML carries the link; once Clerk has loaded on
// the client and finds a session, it swaps to the UserButton.
import Link from 'next/link';
import { UserButton, useAuth } from '@clerk/nextjs';

export default function AccountControl() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) {
    return (
      <span className="site-account">
        <UserButton />
      </span>
    );
  }
  return <Link href="/sign-in" className="site-signin">Sign in</Link>;
}

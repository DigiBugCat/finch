"use client";
// The nav's account slot: for a signed-in visitor, a "Your fleet" link (the
// read-only /fleet page) beside Clerk's UserButton (sign out, switch account);
// a "Sign in" link otherwise. The landing and /docs are prerendered, so the
// server HTML carries the Sign in link; once Clerk has loaded on the client
// and finds a session, it swaps to the signed-in pair.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useAuth } from '@clerk/nextjs';

export default function AccountControl() {
  const { isLoaded, isSignedIn } = useAuth();
  const pathname = usePathname();
  if (isLoaded && isSignedIn) {
    return (
      <>
        <Link href="/fleet" aria-current={pathname === '/fleet' ? 'page' : undefined}>Your fleet</Link>
        <span className="site-account">
          <UserButton />
        </span>
      </>
    );
  }
  return <Link href="/sign-in" className="site-signin">Sign in</Link>;
}

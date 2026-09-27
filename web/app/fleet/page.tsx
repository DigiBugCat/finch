import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import SiteNav from '@/components/fieldguide/SiteNav';
import SiteFooter from '@/components/fieldguide/SiteFooter';
import FleetView, { FleetUnavailable } from '@/components/fleet/FleetView';
import { toFleetView, type FleetView as View } from '@/components/fleet/model';
import { HttpError, readTenantState } from '@/lib/hub';
import '@/components/fleet/fleet.css';

// Signed in (middleware), per-user, read live from the hub — never prerender.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your fleet — finch',
  robots: { index: false, follow: false },
};

type Loaded = { view: View } | { error: string };

async function load(): Promise<Loaded> {
  try {
    return { view: toFleetView(await readTenantState(), Date.now()) };
  } catch (err) {
    if (err instanceof HttpError) {
      // A 401 here is the hub refusing the web itself (a service secret that
      // doesn't match mid-rotation, say), not the person's session, which the
      // page checked first. Sending them to sign-in would loop straight back.
      if (err.status === 401) console.error('finch /fleet: the hub refused the web', err.message);
      // 403s carry a message written for the person (e.g. verify your email).
      if (err.status === 403) return { error: `${err.message[0]?.toUpperCase() ?? ''}${err.message.slice(1)}.` };
    } else {
      console.error('finch /fleet: could not read state', err);
    }
    return { error: 'The hub didn’t answer. Your services are unaffected; this page only reads.' };
  }
}

export default async function FleetPage() {
  // Middleware already guards /fleet; this covers a session that lapsed between
  // the two. Only a missing Clerk session goes to sign-in: any 401 the hub
  // sends later is about the web, and signing in again can't fix it.
  const { userId } = await auth();
  if (!userId) redirect('/sign-in?redirect_url=%2Ffleet');
  const loaded = await load();

  return (
    <div className="fl-page iw-night">
      <SiteNav />
      <main className="iw-wrap fl-main" id="main">
        {'view' in loaded ? <FleetView view={loaded.view} /> : <FleetUnavailable message={loaded.error} />}
      </main>
      <SiteFooter />
    </div>
  );
}

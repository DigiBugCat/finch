import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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

type Loaded = { view: View } | { error: string } | { signIn: true };

async function load(): Promise<Loaded> {
  try {
    return { view: toFleetView(await readTenantState(), Date.now()) };
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) return { signIn: true };
      // 403s carry a message written for the person (e.g. verify your email).
      if (err.status === 403) return { error: `${err.message[0]?.toUpperCase() ?? ''}${err.message.slice(1)}.` };
    } else {
      console.error('finch /fleet: could not read state', err);
    }
    return { error: 'The hub didn’t answer. Your services are unaffected; this page only reads.' };
  }
}

export default async function FleetPage() {
  const loaded = await load();
  // Middleware already guards /fleet; this covers a session that lapsed between
  // the two. redirect() throws, so it runs outside load()'s try.
  if ('signIn' in loaded) redirect('/sign-in?redirect_url=%2Ffleet');

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

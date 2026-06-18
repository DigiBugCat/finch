import DashboardApp from '@/components/dash/DashboardApp';

// Per-user, auth-protected content — never prerender it. Without an incremental
// cache backend, a statically-prerendered protected route (one that must route
// through the server function so middleware can run) has nowhere to be read
// from at runtime and 404s. force-dynamic renders it on demand per request.
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return <DashboardApp />;
}

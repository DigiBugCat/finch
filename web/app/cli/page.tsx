import { Suspense } from 'react';
import CliApprove from '@/components/CliApprove';

// Auth-protected (middleware), per-user — never prerender.
export const dynamic = 'force-dynamic';

export default function CliPage() {
  return (
    <Suspense>
      <CliApprove />
    </Suspense>
  );
}

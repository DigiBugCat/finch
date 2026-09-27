// The frame around Clerk's <SignIn>/<SignUp>: the site nav, a small painted
// wire with the finch waiting on it, then the Clerk card (themed in
// app/layout.tsx).
import type { ReactNode } from 'react';
import { Bird } from './Bird';
import SiteNav from './SiteNav';

export default function AuthShell({ note, children }: { note: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <SiteNav />
      <main className="auth-main">
        <div className="auth-plate">
          <svg viewBox="0 0 400 70" width="400" height="70" aria-hidden="true" focusable="false">
            <path d="M0 52 C 120 64, 280 64, 400 48" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" />
            <g transform="translate(206 58) scale(1.3)">
              <Bird fill="var(--vermilion)" painted />
              <path d="M14 -20 L20 -18 L14 -16Z" style={{ fill: 'var(--ochre)' }} />
            </g>
          </svg>
          <span className="iw-hand">{note}</span>
        </div>
        {children}
      </main>
    </div>
  );
}

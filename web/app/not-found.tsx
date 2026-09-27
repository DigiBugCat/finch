// The 404 for any unknown page on the site, in the field guide's Paper style:
// the nav, an empty wire where the finch should be, and the three places a
// lost visitor most likely wanted.
import type { Metadata } from 'next';
import Link from 'next/link';
import SiteNav from '@/components/fieldguide/SiteNav';
import SiteFooter from '@/components/fieldguide/SiteFooter';
import { Bird } from '@/components/fieldguide/Bird';
import { INSTALL_ONE_LINER } from '@/components/fieldguide/prompt';
import '@/components/fieldguide/landing.css';

// Next already marks a 404 noindex, so only the title is set here.
export const metadata: Metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <>
      <SiteNav />
      <main className="iw-wrap fg-404">
        <svg className="fg-404-wire" viewBox="0 0 640 120" width="640" height="120" aria-hidden="true" focusable="false">
          <path d="M0 70 C 200 94, 440 94, 640 64" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" />
          <path d="M306 84 m-10 0 a10 4 0 1 0 20 0 a10 4 0 1 0 -20 0" fill="none" style={{ stroke: 'var(--ink-muted)' }} strokeWidth="1" strokeDasharray="2 3" />
          <g transform="translate(520 34) scale(1.4) rotate(-12)">
            <Bird fill="var(--vermilion)" painted />
          </g>
          <text x="330" y="118" className="fg-svg-hand" style={{ fill: 'var(--indigo)', fontSize: 16 }}>
            it was here a moment ago
          </text>
        </svg>
        <span className="iw-label iw-label-indigo">404 · Not in this guide</span>
        <h1>This page has flown off.</h1>
        <p className="fg-404-lede">
          The address may be mistyped, or the page may have moved. These are the places most people are looking for:
        </p>
        <ul className="fg-404-links">
          <li>
            <Link href="/docs" className="fg-strong-link">The quickstart</Link>
            <span>Put a local MCP server online in a few commands.</span>
          </li>
          <li>
            <a href="/agents.md" className="fg-strong-link">agents.md</a>
            <span>The step-by-step guide to hand your AI agent.</span>
          </li>
          <li>
            <Link href="/" className="fg-strong-link">The field guide</Link>
            <span>What finch is, in seven plates.</span>
          </li>
        </ul>
        <div className="fg-404-install">
          <span className="iw-label">Or just install it</span>
          <code>{INSTALL_ONE_LINER}</code>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

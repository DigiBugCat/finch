import Link from 'next/link';
import { BirdMark } from './Bird';

// Anchors point at the landing's plates with a leading "/" so the same nav
// works from /docs; on the landing itself they resolve to in-page jumps.
const ANCHORS: [string, string][] = [
  ['/#band', 'The band'],
  ['/#gate', 'The gate'],
  ['/#agents', 'For agents'],
  ['/#pricing', 'Pricing'],
];

export default function SiteNav() {
  return (
    <header className="iw-wrap site-nav">
      <Link href="/" className="site-logo" aria-label="finch home">
        <BirdMark />
        <span className="site-logo-word">finch</span>
        <span className="site-logo-tag" aria-hidden="true">a field guide</span>
      </Link>
      <nav aria-label="Main" className="site-links">
        {ANCHORS.map(([href, label]) => (
          <a key={href} href={href} className="site-anchor">{label}</a>
        ))}
        <Link href="/docs">Docs</Link>
        <Link href="/sign-in" className="site-signin">Sign in</Link>
      </nav>
    </header>
  );
}

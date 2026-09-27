import Link from 'next/link';

export default function SiteFooter() {
  return (
    <footer className="iw-wrap site-foot">
      <span className="site-foot-note">
        finch is free and open source, under the MIT license.{' '}
        <span className="iw-hand">Drawn at home, mostly after midnight.</span>
      </span>
      <nav aria-label="Footer">
        <Link href="/docs">Docs</Link>
        <a href="/agents.md">agents.md</a>
        <a href="/llms.txt">llms.txt</a>
        <Link href="/docs/privacy">Privacy</Link>
        <a href="https://github.com/DigiBugCat/finch">Source on GitHub</a>
      </nav>
    </footer>
  );
}

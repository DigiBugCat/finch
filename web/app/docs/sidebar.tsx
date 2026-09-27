"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: { h: string; items: [string, string][] }[] = [
  {
    h: 'Get started',
    items: [
      ['/docs', 'Quickstart'],
      ['/docs/services', 'Services & machines'],
    ],
  },
  {
    h: 'Guides',
    items: [
      ['/docs/auth', 'Keys & auth'],
      ['/docs/acls', 'Access control'],
      ['/docs/domains', 'Domains'],
    ],
  },
  {
    h: 'Reference',
    items: [
      ['/docs/cli', 'CLI'],
      ['/docs/privacy', 'Privacy & data handling'],
    ],
  },
  {
    h: 'Related',
    items: [
      ['/docs/aviarymcp', 'AviaryMCP (Python SDK)'],
    ],
  },
];

export default function DocsSidebar() {
  const path = usePathname();
  return (
    <nav className="docs-side" aria-label="Docs">
      {GROUPS.map((g) => (
        <div className="docs-group" key={g.h}>
          <div className="docs-group-h" id={`docs-group-${g.h.replace(/\W+/g, '-').toLowerCase()}`}>{g.h}</div>
          <ul aria-labelledby={`docs-group-${g.h.replace(/\W+/g, '-').toLowerCase()}`}>
            {g.items.map(([href, label]) => {
              const on = path === href;
              return (
                <li key={href}>
                  <Link href={href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

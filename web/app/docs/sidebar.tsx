"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: { h: string; items: [string, string][] }[] = [
  {
    h: 'Get started',
    items: [
      ['/docs', 'Quickstart'],
      ['/docs/services', 'Services & boxes'],
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
    ],
  },
];

export default function DocsSidebar() {
  const path = usePathname();
  return (
    <nav className="docs-side" aria-label="Docs">
      {GROUPS.map((g) => (
        <div className="docs-group" key={g.h}>
          <div className="docs-group-h">{g.h}</div>
          {g.items.map(([href, label]) => (
            <Link key={href} href={href} className={path === href ? 'on' : ''}>
              {label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
